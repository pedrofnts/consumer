const config = require('../config/config');
const logger = require('../utils/logger');
const helpers = require('../utils/helpers');

class MessageProcessor {
    constructor(webhookService, deduplicationService, rabbitMQService) {
        this.webhookService = webhookService;
        this.deduplicationService = deduplicationService;
        this.rabbitMQService = rabbitMQService;
        
        // Estatísticas
        this.stats = {
            processed: 0,
            failed: 0,
            skipped: 0,
            duplicates: 0,
            outsideBusinessHours: 0,
            paused: 0
        };
    }

    /**
     * Processa uma mensagem do RabbitMQ
     */
    async processMessage(msg, queueConfig) {
        if (!msg) {
            logger.warn('Received null message, skipping');
            return { action: 'skip', reason: 'null_message' };
        }

        const messageId = this.deduplicationService.generateMessageId(msg);
        const { queue, webhook, minInterval, maxInterval, businessHours, paused } = queueConfig;

        logger.consumer('Processing message', {
            messageId,
            queue,
            deliveryTag: msg.fields.deliveryTag
        });

        try {
            // 1. Verificar duplicação
            if (this.deduplicationService.isMessageProcessed(messageId)) {
                logger.consumer('Skipping duplicate message', { messageId, queue });
                // NÃO fazer ACK/NACK - mensagem já foi processada antes
                // Fazer ACK/NACK causaria erro "unknown delivery tag"
                this.stats.duplicates++;
                this.stats.skipped++;
                return { action: 'skip', reason: 'duplicate' };
            }

            // 2. Verificar se consumer está pausado
            if (paused) {
                logger.consumer('Consumer paused, returning message to queue', { queue });
                await this.rabbitMQService.nackMessage(msg, false, true);
                this.stats.paused++;
                this.stats.skipped++;
                return { action: 'nack', reason: 'paused' };
            }

            // 3. Verificar horário comercial
            if (!helpers.isWithinBusinessHours(businessHours)) {
                const currentHour = new Date().getHours();
                logger.consumer('Outside business hours, returning message to queue', {
                    queue,
                    currentHour,
                    businessHours
                });
                await this.rabbitMQService.nackMessage(msg, false, true);
                this.stats.outsideBusinessHours++;
                this.stats.skipped++;
                return { action: 'nack', reason: 'outside_business_hours' };
            }

            // 4. Marcar como em processamento
            this.deduplicationService.markMessageProcessing(messageId, {
                queue,
                deliveryTag: msg.fields.deliveryTag,
                webhook
            });

            // 5. Parsear conteúdo da mensagem
            let messageContent;
            try {
                messageContent = JSON.parse(msg.content.toString());
            } catch (parseError) {
                logger.error('Failed to parse message content', parseError, {
                    messageId,
                    queue,
                    contentLength: msg.content.length
                });
                
                await this.rabbitMQService.ackMessage(msg);
                this.deduplicationService.markMessageProcessed(messageId);
                this.stats.failed++;
                
                return { action: 'ack', reason: 'parse_error', error: parseError.message };
            }

            // 6. Enviar para webhook
            const webhookResult = await this.sendToWebhook(webhook, messageContent, messageId);
            
            if (webhookResult.success) {
                // Sucesso - ACK da mensagem
                await this.rabbitMQService.ackMessage(msg);
                this.deduplicationService.markMessageProcessed(messageId);
                this.stats.processed++;

                logger.consumer('Message processed successfully', {
                    messageId,
                    queue,
                    webhookResponseTime: webhookResult.responseTime
                });

                return {
                    action: 'ack',
                    reason: 'success',
                    webhookResult,
                    messageContent
                };

            } else {
                // Falha no webhook
                const shouldRetry = this.shouldRetryMessage(webhookResult.error);
                
                if (shouldRetry) {
                    await this.rabbitMQService.nackMessage(msg, false, true);
                    logger.consumer('Message webhook failed, returning for retry', {
                        messageId,
                        queue,
                        error: webhookResult.error.message,
                        status: webhookResult.error.status
                    });
                } else {
                    // Erro permanente - descartar mensagem
                    await this.rabbitMQService.ackMessage(msg);
                    this.deduplicationService.markMessageProcessed(messageId);
                    logger.consumer('Message discarded due to permanent webhook error', {
                        messageId,
                        queue,
                        error: webhookResult.error.message,
                        status: webhookResult.error.status
                    });
                }

                this.stats.failed++;
                return {
                    action: shouldRetry ? 'nack' : 'ack',
                    reason: shouldRetry ? 'webhook_retry' : 'webhook_permanent_error',
                    error: webhookResult.error
                };
            }

        } catch (error) {
            logger.error('Unexpected error processing message', error, {
                messageId,
                queue
            });

            // Em caso de erro inesperado, fazer NACK para retry
            await this.rabbitMQService.nackMessage(msg, false, true);
            this.stats.failed++;

            return {
                action: 'nack',
                reason: 'unexpected_error',
                error: error.message
            };

        } finally {
            // Sempre remover do estado de processamento
            this.deduplicationService.removeMessageFromProcessing(messageId);
        }
    }

    /**
     * Envia mensagem para webhook
     */
    async sendToWebhook(webhookUrl, messageContent, messageId) {
        try {
            const result = await this.webhookService.sendWebhookWithRetry(
                webhookUrl,
                messageContent,
                { timeout: config.webhook.timeout }
            );

            return {
                success: true,
                ...result
            };

        } catch (error) {
            return {
                success: false,
                error: error
            };
        }
    }

    /**
     * Determina se uma mensagem deve ser reenviada baseado no erro do webhook
     */
    shouldRetryMessage(error) {
        // Não fazer retry em erros 4xx (client errors)
        if (error.status && error.status >= 400 && error.status < 500) {
            return false;
        }

        // Retry em erros 5xx, timeouts e erros de rede
        return true;
    }

    /**
     * Aplica delay antes de processar próxima mensagem
     */
    async applyProcessingDelay(queueName, minInterval, maxInterval) {
        const delay = helpers.getRandomInterval(minInterval, maxInterval);
        
        logger.consumer('Applying processing delay', {
            queue: queueName,
            delayMs: delay,
            delaySeconds: Math.round(delay / 1000)
        });

        await helpers.sleep(delay);
        return delay;
    }

    /**
     * Valida configuração de fila
     */
    validateQueueConfig(config) {
        const errors = [];

        if (!helpers.isValidQueueName(config.queue)) {
            errors.push('Invalid queue name');
        }

        if (!helpers.isValidUrl(config.webhook)) {
            errors.push('Invalid webhook URL');
        }

        const { min, max } = helpers.sanitizeIntervals(config.minInterval, config.maxInterval);
        if (min >= max) {
            errors.push('Minimum interval must be less than maximum interval');
        }

        if (config.businessHours) {
            const { start, end } = config.businessHours;
            if (start < 0 || start > 23 || end < 0 || end > 23 || start >= end) {
                errors.push('Invalid business hours configuration');
            }
        }

        return {
            isValid: errors.length === 0,
            errors,
            sanitizedConfig: {
                ...config,
                minInterval: min,
                maxInterval: max
            }
        };
    }

    /**
     * Gera relatório de fila (contagem, tempo estimado, etc.)
     */
    async generateQueueReport(queueName, queueConfig) {
        try {
            const queueInfo = await this.rabbitMQService.checkQueue(queueName);
            const { minInterval, maxInterval } = queueConfig;
            
            const messageCount = queueInfo.messageCount;
            const avgInterval = (minInterval + maxInterval) / 2;
            const estimatedTimeMs = messageCount * avgInterval;

            return {
                queue: queueName,
                messageCount,
                consumerCount: queueInfo.consumerCount,
                estimatedCompletion: helpers.formatEstimatedTime(estimatedTimeMs),
                config: {
                    minInterval,
                    maxInterval,
                    avgIntervalSeconds: avgInterval / 1000,
                    businessHours: queueConfig.businessHours,
                    webhook: queueConfig.webhook,
                    paused: queueConfig.paused || false
                }
            };

        } catch (error) {
            return {
                queue: queueName,
                error: error.code === 404 ? 'Queue not found' : error.message,
                config: queueConfig
            };
        }
    }

    /**
     * Obtém estatísticas do processador
     */
    getStats() {
        const total = this.stats.processed + this.stats.failed + this.stats.skipped;
        const successRate = total > 0 ? (this.stats.processed / total * 100).toFixed(2) : 0;

        return {
            ...this.stats,
            total,
            successRate: parseFloat(successRate),
            deduplicationStats: this.deduplicationService.getStats(),
            webhookStats: this.webhookService.getStats()
        };
    }

    /**
     * Reseta estatísticas
     */
    resetStats() {
        this.stats = {
            processed: 0,
            failed: 0,
            skipped: 0,
            duplicates: 0,
            outsideBusinessHours: 0,
            paused: 0
        };

        this.webhookService.resetStats();
        logger.consumer('Message processor statistics reset');
    }

    /**
     * Shutdown graceful do processador
     */
    async shutdown() {
        logger.consumer('Message processor shutdown complete');
    }
}

module.exports = MessageProcessor; 