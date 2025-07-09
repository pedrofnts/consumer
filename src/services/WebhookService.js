const axios = require('axios');
const config = require('../config/config');
const logger = require('../utils/logger');
const helpers = require('../utils/helpers');

class WebhookService {
    constructor() {
        this.timeout = config.webhook.timeout;
        this.retryAttempts = config.webhook.retryAttempts;
        this.retryDelay = config.webhook.retryDelay;
        this.headers = config.webhook.headers;
        this.finishWebhookUrl = config.webhook.finishUrl;
        
        // Estatísticas
        this.stats = {
            sent: 0,
            failed: 0,
            retries: 0,
            avgResponseTime: 0,
            totalResponseTime: 0
        };
    }

    /**
     * Envia dados para um webhook
     */
    async sendWebhook(url, data, options = {}) {
        if (!helpers.isValidUrl(url)) {
            throw new Error(`Invalid webhook URL: ${url}`);
        }

        const startTime = Date.now();
        const requestOptions = {
            timeout: options.timeout || this.timeout,
            headers: {
                ...this.headers,
                ...options.headers
            },
            validateStatus: (status) => status < 500 // Retry apenas em erros 5xx
        };

        logger.webhook('Sending webhook', { 
            url, 
            timeout: requestOptions.timeout,
            dataSize: JSON.stringify(data).length 
        });

        try {
            const response = await axios.post(url, data, requestOptions);
            const responseTime = Date.now() - startTime;
            
            this._updateStats(true, responseTime);
            
            logger.webhook('Webhook sent successfully', {
                url,
                status: response.status,
                responseTimeMs: responseTime
            });

            return {
                success: true,
                status: response.status,
                data: response.data,
                responseTime
            };

        } catch (error) {
            const responseTime = Date.now() - startTime;
            this._updateStats(false, responseTime);
            
            const errorInfo = {
                url,
                error: error.message,
                responseTimeMs: responseTime,
                status: error.response?.status,
                statusText: error.response?.statusText
            };

            logger.error('Webhook failed', error, errorInfo);

            throw {
                ...error,
                isWebhookError: true,
                responseTime,
                status: error.response?.status,
                data: error.response?.data
            };
        }
    }

    /**
     * Envia webhook com retry automático
     */
    async sendWebhookWithRetry(url, data, options = {}) {
        const maxAttempts = options.retryAttempts || this.retryAttempts;
        const baseDelay = options.retryDelay || this.retryDelay;
        
        let lastError;
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const result = await this.sendWebhook(url, data, options);
                
                if (attempt > 1) {
                    logger.webhook('Webhook succeeded after retry', {
                        url,
                        attempt,
                        totalAttempts: maxAttempts
                    });
                }
                
                return result;
                
            } catch (error) {
                lastError = error;
                this.stats.retries++;
                
                // Não fazer retry em erros 4xx (client errors)
                if (error.status && error.status >= 400 && error.status < 500) {
                    logger.webhook('Not retrying webhook due to client error', {
                        url,
                        status: error.status,
                        attempt
                    });
                    break;
                }
                
                if (attempt < maxAttempts) {
                    const delay = baseDelay * Math.pow(2, attempt - 1);
                    
                    logger.webhook('Webhook failed, retrying', {
                        url,
                        attempt,
                        totalAttempts: maxAttempts,
                        delayMs: delay,
                        error: error.message
                    });
                    
                    await helpers.sleep(delay);
                } else {
                    logger.webhook('Webhook failed after all retries', {
                        url,
                        totalAttempts: maxAttempts,
                        finalError: error.message
                    });
                }
            }
        }
        
        throw lastError;
    }

    /**
     * Envia notificação de finalização de fila
     */
    async notifyQueueFinish(queueName, lastMessage = null, metadata = {}) {
        if (!this.finishWebhookUrl) {
            logger.debug('No finish webhook URL configured, skipping notification');
            return null;
        }

        const payload = {
            event: 'queue_finished',
            queue: queueName,
            lastMessage,
            timestamp: new Date().toISOString(),
            metadata
        };

        try {
            const result = await this.sendWebhookWithRetry(
                this.finishWebhookUrl,
                payload,
                { timeout: this.timeout }
            );

            logger.webhook('Queue finish notification sent', {
                queue: queueName,
                responseTime: result.responseTime
            });

            return result;

        } catch (error) {
            logger.error('Failed to send queue finish notification', error, {
                queue: queueName,
                webhookUrl: this.finishWebhookUrl
            });
            
            // Não propagamos o erro para não afetar o processamento principal
            return null;
        }
    }

    /**
     * Testa se um webhook está responsivo
     */
    async testWebhook(url, options = {}) {
        const testPayload = {
            test: true,
            timestamp: new Date().toISOString(),
            message: 'Webhook connectivity test'
        };

        try {
            const result = await this.sendWebhook(url, testPayload, {
                timeout: options.timeout || 5000
            });

            return {
                success: true,
                responseTime: result.responseTime,
                status: result.status
            };

        } catch (error) {
            return {
                success: false,
                error: error.message,
                status: error.status,
                responseTime: error.responseTime
            };
        }
    }

    /**
     * Valida formato de webhook
     */
    validateWebhookConfig(config) {
        const errors = [];

        if (!config.url) {
            errors.push('Webhook URL is required');
        } else if (!helpers.isValidUrl(config.url)) {
            errors.push('Invalid webhook URL format');
        }

        if (config.timeout && (config.timeout < 1000 || config.timeout > 60000)) {
            errors.push('Webhook timeout must be between 1000ms and 60000ms');
        }

        if (config.retryAttempts && (config.retryAttempts < 0 || config.retryAttempts > 10)) {
            errors.push('Retry attempts must be between 0 and 10');
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Atualiza estatísticas internas
     */
    _updateStats(success, responseTime) {
        if (success) {
            this.stats.sent++;
        } else {
            this.stats.failed++;
        }

        this.stats.totalResponseTime += responseTime;
        const totalRequests = this.stats.sent + this.stats.failed;
        this.stats.avgResponseTime = Math.round(this.stats.totalResponseTime / totalRequests);
    }

    /**
     * Obtém estatísticas do serviço
     */
    getStats() {
        const totalRequests = this.stats.sent + this.stats.failed;
        const successRate = totalRequests > 0 ? (this.stats.sent / totalRequests * 100).toFixed(2) : 0;

        return {
            ...this.stats,
            totalRequests,
            successRate: parseFloat(successRate),
            config: {
                timeout: this.timeout,
                retryAttempts: this.retryAttempts,
                retryDelay: this.retryDelay,
                finishWebhookConfigured: !!this.finishWebhookUrl
            }
        };
    }

    /**
     * Reseta estatísticas
     */
    resetStats() {
        this.stats = {
            sent: 0,
            failed: 0,
            retries: 0,
            avgResponseTime: 0,
            totalResponseTime: 0
        };
        
        logger.webhook('Statistics reset');
    }

    /**
     * Shutdown graceful do serviço
     */
    async shutdown() {
        logger.webhook('Webhook service shutdown complete');
    }
}

module.exports = WebhookService; 