const EventEmitter = require('events');
const config = require('../config/config');
const logger = require('../utils/logger');
const helpers = require('../utils/helpers');

class ConsumerService extends EventEmitter {
    constructor(rabbitMQService, reconnectionService, messageProcessor, webhookService, deduplicationService, persistenceService) {
        super();
        
        // Serviços
        this.rabbitMQService = rabbitMQService;
        this.reconnectionService = reconnectionService;
        this.messageProcessor = messageProcessor;
        this.webhookService = webhookService;
        this.deduplicationService = deduplicationService;
        this.persistenceService = persistenceService;
        
        // Estado
        this.activeConsumers = new Map();
        this.queueIntervals = new Map();
        this.isShuttingDown = false;
        this.isInitialized = false;
        this.healthCheckInterval = null;
        
        this.setupEventHandlers();
    }

    /**
     * Configura event handlers
     */
    setupEventHandlers() {
        // Eventos de reconexão
        this.reconnectionService.on('reconnectionSuccessful', () => {
            this.handleReconnectionSuccess();
        });

        this.reconnectionService.on('maxAttemptsReached', () => {
            this.handleMaxReconnectionAttempts();
        });

        // Eventos do RabbitMQ
        this.rabbitMQService.on('consumerCancelled', (consumerTag) => {
            this.handleConsumerCancelled(consumerTag);
        });
    }

    /**
     * Inicializa o serviço
     */
    async initialize() {
        if (this.isInitialized) {
            logger.consumer('Service already initialized');
            return;
        }

        try {
            logger.consumer('Initializing consumer service...');
            
            // Conectar ao RabbitMQ
            await this.rabbitMQService.connect();
            
            this.isInitialized = true;
            logger.consumer('Consumer service initialized successfully');
            
            // Restaurar filas salvas automaticamente
            const restorationResult = await this.restorePersistedQueues();
            if (restorationResult.restored > 0) {
                logger.consumer('Auto-restoration completed', {
                    restored: restorationResult.restored,
                    failed: restorationResult.failed,
                    skipped: restorationResult.skipped
                });
            }
            
            // Iniciar monitoramento periódico de saúde das filas
            this.startQueueHealthMonitoring();
            
            this.emit('initialized', { restorationResult });
            
        } catch (error) {
            logger.error('Failed to initialize consumer service', error);
            throw error;
        }
    }

    /**
     * Inicia consumo de uma fila
     */
    async startConsuming(queueName, webhook, minInterval, maxInterval, businessHours) {
        if (!this.isInitialized) {
            throw new Error('Service not initialized. Call initialize() first.');
        }

        // Validar configuração
        const validation = this.messageProcessor.validateQueueConfig({
            queue: queueName,
            webhook,
            minInterval,
            maxInterval,
            businessHours
        });

        if (!validation.isValid) {
            throw new Error(`Invalid queue configuration: ${validation.errors.join(', ')}`);
        }

        const { sanitizedConfig } = validation;
        const { minInterval: min, maxInterval: max } = sanitizedConfig;

        // Verificar se já existe consumer para esta fila
        if (this.activeConsumers.has(queueName)) {
            throw new Error(`Queue ${queueName} is already being consumed`);
        }

        try {
            // Verificar se a fila existe
            await this.rabbitMQService.checkQueue(queueName);

            // Criar handler de mensagens
            const messageHandler = this.createMessageHandler(queueName, webhook, min, max, businessHours);

            // Criar consumer
            const consumer = await this.rabbitMQService.createConsumer(queueName, messageHandler);

            // Configurar estado do consumer
            const consumerConfig = {
                consumerTag: consumer.consumerTag,
                webhook,
                minInterval: min,
                maxInterval: max,
                businessHours,
                paused: false,
                lastMessage: null,
                createdAt: new Date().toISOString(),
                messageCount: 0
            };

            this.activeConsumers.set(queueName, consumerConfig);
            this.queueIntervals.set(queueName, helpers.getRandomInterval(min, max));

            // Salvar configuração persistente
            if (this.persistenceService) {
                try {
                    await this.persistenceService.saveQueueConfig(queueName, {
                        webhook,
                        minInterval: min,
                        maxInterval: max,
                        businessHours
                    });
                } catch (error) {
                    logger.warn('Failed to save queue configuration to persistence', error, { queue: queueName });
                }
            }

            logger.consumer('Started consuming queue', {
                queue: queueName,
                webhook,
                consumerTag: consumer.consumerTag,
                minInterval: min,
                maxInterval: max,
                businessHours
            });

            this.emit('consumerStarted', {
                queue: queueName,
                consumerTag: consumer.consumerTag,
                config: consumerConfig
            });

            return consumerConfig;

        } catch (error) {
            logger.error('Failed to start consuming queue', error, { queue: queueName });
            throw error;
        }
    }

    /**
     * Cria handler de mensagens para uma fila
     */
    createMessageHandler(queueName, webhook, minInterval, maxInterval, businessHours) {
        return async (msg) => {
            // Cancelamento do consumer
            if (msg === null) {
                logger.consumer('Consumer cancelled', { queue: queueName });
                
                // Limpar estado local
                this.activeConsumers.delete(queueName);
                this.queueIntervals.delete(queueName);
                
                // Remover da persistência automaticamente quando consumer é cancelado
                if (this.persistenceService) {
                    try {
                        const wasRemoved = await this.persistenceService.removeQueueConfig(queueName);
                        if (wasRemoved) {
                            logger.info('Automatically removed cancelled queue from persistence', { queue: queueName });
                        }
                    } catch (persistError) {
                        logger.error('Failed to remove cancelled queue from persistence', persistError, { queue: queueName });
                    }
                }
                
                this.emit('consumerCancelled', { queue: queueName });
                return;
            }

            const consumerConfig = this.activeConsumers.get(queueName);
            if (!consumerConfig) {
                logger.warn('Received message for unknown consumer', { queue: queueName });
                await this.rabbitMQService.nackMessage(msg, false, true);
                return;
            }

            let messageProcessingResult = null;
            
            try {
                // Aplicar delay antes de processar
                const currentInterval = this.queueIntervals.get(queueName);
                if (currentInterval) {
                    await helpers.sleep(currentInterval);
                }

                // Processar mensagem
                messageProcessingResult = await this.messageProcessor.processMessage(msg, {
                    queue: queueName,
                    webhook,
                    minInterval,
                    maxInterval,
                    businessHours,
                    paused: consumerConfig.paused
                });

                // Atualizar estatísticas do consumer
                consumerConfig.messageCount++;
                if (messageProcessingResult.messageContent) {
                    consumerConfig.lastMessage = messageProcessingResult.messageContent;
                }

                // Definir próximo intervalo se mensagem foi processada com sucesso
                if (messageProcessingResult.action === 'ack' && messageProcessingResult.reason === 'success') {
                    this.queueIntervals.set(queueName, helpers.getRandomInterval(minInterval, maxInterval));
                    
                    // Não verificar fila vazia - desnecessário e causa problemas
                }

                this.emit('messageProcessed', {
                    queue: queueName,
                    result: messageProcessingResult,
                    messageId: messageProcessingResult.messageId
                });

            } catch (error) {
                logger.error('Error in message handler', error, { queue: queueName });
                
                // ✅ CORREÇÃO: Não fazer NACK se mensagem foi skipada (duplicada)
                // Isso evita o erro "unknown delivery tag" 
                if (messageProcessingResult && messageProcessingResult.action === 'skip') {
                    logger.debug('Skipping NACK for skipped message', { 
                        queue: queueName, 
                        reason: messageProcessingResult.reason 
                    });
                } else {
                    // Tentar NACK apenas se mensagem não foi skipada
                    await this.rabbitMQService.nackMessage(msg, false, true);
                }
            }
        };
    }

    /**
     * Verifica se fila ficou vazia e remove consumer se necessário
     * Simplificado - só faz verificação quando canal está OK
     */
    async checkQueueEmpty(queueName) {
        // Só tentar se canal estiver funcionando
        if (!this.rabbitMQService.isChannelReady()) {
            return;
        }

        try {
            const queueInfo = await this.rabbitMQService.checkQueue(queueName);
            
            if (queueInfo.messageCount === 0) {
                const consumerConfig = this.activeConsumers.get(queueName);
                if (consumerConfig) {
                    await this.stopConsuming(queueName, 'queue_empty');
                    
                    // Notificar finalização
                    await this.webhookService.notifyQueueFinish(
                        queueName,
                        consumerConfig.lastMessage,
                        { reason: 'queue_empty' }
                    );
                }
            }
        } catch (error) {
            // Não fazer nada - deixar reconexão resolver
        }
    }

    /**
     * Limpa automaticamente consumer e configuração de fila deletada externamente
     */
    async handleExternallyDeletedQueue(queueName) {
        try {
            const consumerConfig = this.activeConsumers.get(queueName);
            
            logger.consumer('Handling externally deleted queue', { 
                queue: queueName, 
                hadActiveConsumer: !!consumerConfig 
            });
            
            // Remover consumer local sem tentar cancelar no RabbitMQ (fila não existe mais)
            if (consumerConfig) {
                this.activeConsumers.delete(queueName);
                this.queueIntervals.delete(queueName);
                
                logger.consumer('Cleaned up local consumer state', {
                    queue: queueName,
                    messageCount: consumerConfig.messageCount
                });
            }
            
            // Remover da persistência - SEMPRE tentar
            if (this.persistenceService) {
                try {
                    const wasRemoved = await this.persistenceService.removeQueueConfig(queueName);
                    if (wasRemoved) {
                        logger.info('Successfully removed externally deleted queue from persistence', { 
                            queue: queueName 
                        });
                    } else {
                        logger.warn('Queue configuration was not found in persistence', { 
                            queue: queueName 
                        });
                    }
                } catch (persistError) {
                    logger.error('Failed to remove externally deleted queue from persistence', 
                        persistError, { queue: queueName });
                }
            }
            
            // Notificar webhook sobre a remoção (se havia consumer ativo)
            if (consumerConfig) {
                try {
                    await this.webhookService.notifyQueueFinish(
                        queueName,
                        consumerConfig.lastMessage,
                        { reason: 'queue_deleted_externally' }
                    );
                    logger.consumer('Notified webhook about externally deleted queue', { queue: queueName });
                } catch (webhookError) {
                    logger.warn('Failed to notify webhook about externally deleted queue', 
                        webhookError, { queue: queueName });
                }
            }
            
            this.emit('queueDeletedExternally', {
                queue: queueName,
                config: consumerConfig,
                cleanupSuccessful: true
            });

            logger.consumer('Successfully handled externally deleted queue', {
                queue: queueName,
                removedFromMemory: !!consumerConfig,
                removedFromPersistence: true
            });
            
        } catch (error) {
            logger.error('Error handling externally deleted queue', error, { queue: queueName });
            
            this.emit('queueDeletedExternally', {
                queue: queueName,
                config: null,
                cleanupSuccessful: false,
                error: error.message
            });
        }
    }

    /**
     * Inicia monitoramento periódico de saúde das filas - INTELIGENTE
     */
    startQueueHealthMonitoring() {
        // Verificar saúde das filas a cada 5 minutos - menos frequente
        this.healthCheckInterval = setInterval(async () => {
            if (this.isShuttingDown || !this.isInitialized) {
                return;
            }

            const activeQueues = Array.from(this.activeConsumers.keys());
            if (activeQueues.length === 0) {
                return;
            }

            // ✅ MELHORIA: Verificar conectividade ANTES de fazer health check
            if (!this.rabbitMQService.isChannelReady()) {
                logger.consumer('Skipping health check - channel not ready, triggering reconnection check');
                
                // Disparar verificação de reconexão se canal não estiver pronto
                this.rabbitMQService.emit('needsReconnection', new Error('Channel not ready during health check'));
                return;
            }

            logger.consumer('Running periodic queue health check', { activeQueues: activeQueues.length });

            let deletedQueues = 0;
            let healthyQueues = 0;
            let connectionErrors = 0;

            // Verificar cada fila ativa de forma mais inteligente
            for (const queueName of activeQueues) {
                try {
                    await this.rabbitMQService.checkQueue(queueName);
                    healthyQueues++;
                } catch (error) {
                    const errorMessage = error.message.toLowerCase();
                    
                    // Filas deletadas externamente
                    if (errorMessage.includes('not_found') || 
                        errorMessage.includes('does not exist') || 
                        errorMessage.includes('no queue') ||
                        (error.code && error.code === 404)) {
                        
                        logger.warn('Detected externally deleted queue during health check', { queue: queueName });
                        await this.handleExternallyDeletedQueue(queueName);
                        deletedQueues++;
                        
                    // Erros de conectividade - parar health check e disparar reconexão
                    } else if (errorMessage.includes('channel closed') || 
                               errorMessage.includes('connection closed') ||
                               errorMessage.includes('socket closed')) {
                        
                        logger.warn('Connection error detected during health check, stopping check and triggering reconnection', { 
                            queue: queueName, 
                            error: error.message 
                        });
                        
                        connectionErrors++;
                        
                        // ✅ MELHORIA: Disparar reconexão imediatamente e parar health check
                        this.rabbitMQService.emit('needsReconnection', error);
                        break; // Parar de verificar outras filas
                        
                    } else {
                        // Outros erros - logar mas continuar
                        logger.warn('Queue health check failed with unknown error', { 
                            queue: queueName, 
                            error: error.message 
                        });
                        connectionErrors++;
                    }
                }
            }

            // ✅ MELHORIA: Logging mais informativo
            if (connectionErrors > 0) {
                logger.consumer('Health check completed with connection errors', { 
                    checkedQueues: activeQueues.length,
                    healthyQueues,
                    deletedQueues,
                    connectionErrors,
                    remainingActiveQueues: this.activeConsumers.size
                });
            } else if (deletedQueues > 0) {
                logger.consumer('Health check completed with deleted queues', { 
                    checkedQueues: activeQueues.length,
                    healthyQueues,
                    deletedQueues,
                    remainingActiveQueues: this.activeConsumers.size
                });
            } else {
                logger.consumer('Health check completed successfully', { 
                    checkedQueues: activeQueues.length,
                    healthyQueues
                });
            }
            
        }, 300000); // 5 minutos
    }

    /**
     * Para o monitoramento de saúde das filas
     */
    stopQueueHealthMonitoring() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
            logger.consumer('Stopped periodic queue health monitoring');
        }
    }

    /**
     * Para o consumo de uma fila
     */
    async stopConsuming(queueName, reason = 'manual') {
        const consumerConfig = this.activeConsumers.get(queueName);
        if (!consumerConfig) {
            throw new Error(`Queue ${queueName} is not being consumed`);
        }

        try {
            // Cancelar consumer no RabbitMQ
            if (consumerConfig.consumerTag && this.rabbitMQService.isChannelReady()) {
                await this.rabbitMQService.cancelConsumer(consumerConfig.consumerTag);
            }

            // Remover estado local
            this.activeConsumers.delete(queueName);
            this.queueIntervals.delete(queueName);

            // Se foi parado manualmente, remover da persistência também
            if (reason === 'manual' && this.persistenceService) {
                try {
                    const wasRemoved = await this.persistenceService.removeQueueConfig(queueName);
                    if (wasRemoved) {
                        logger.info('Removed manually stopped queue from persistence', { 
                            queue: queueName,
                            reason 
                        });
                    }
                } catch (persistError) {
                    logger.error('Failed to remove manually stopped queue from persistence', 
                        persistError, { queue: queueName, reason });
                }
            }

            logger.consumer('Stopped consuming queue', {
                queue: queueName,
                reason,
                messageCount: consumerConfig.messageCount,
                consumerTag: consumerConfig.consumerTag
            });

            this.emit('consumerStopped', {
                queue: queueName,
                reason,
                config: consumerConfig
            });

            return {
                queue: queueName,
                reason,
                messageCount: consumerConfig.messageCount,
                stoppedAt: new Date().toISOString()
            };

        } catch (error) {
            logger.error('Error stopping consumer', error, { queue: queueName, reason });
            throw error;
        }
    }

    /**
     * Pausa o consumo de uma fila
     */
    pauseConsuming(queueName) {
        const consumerConfig = this.activeConsumers.get(queueName);
        if (!consumerConfig) {
            throw new Error(`Queue ${queueName} is not being consumed`);
        }

        if (consumerConfig.paused) {
            throw new Error(`Queue ${queueName} is already paused`);
        }

        consumerConfig.paused = true;
        
        logger.consumer('Paused consuming queue', { queue: queueName });
        this.emit('consumerPaused', { queue: queueName });
        
        return consumerConfig;
    }

    /**
     * Resume o consumo de uma fila
     */
    resumeConsuming(queueName) {
        const consumerConfig = this.activeConsumers.get(queueName);
        if (!consumerConfig) {
            throw new Error(`Queue ${queueName} is not being consumed`);
        }

        if (!consumerConfig.paused) {
            throw new Error(`Queue ${queueName} is not paused`);
        }

        consumerConfig.paused = false;
        
        logger.consumer('Resumed consuming queue', { queue: queueName });
        this.emit('consumerResumed', { queue: queueName });
        
        return consumerConfig;
    }

    /**
     * Obtém informações de uma fila
     */
    async getQueueInfo(queueName) {
        try {
            const queueInfo = await this.rabbitMQService.checkQueue(queueName);
            const consumerConfig = this.activeConsumers.get(queueName);
            
            return {
                queue: queueName,
                messageCount: queueInfo.messageCount,
                consumerCount: queueInfo.consumerCount,
                isActive: !!consumerConfig,
                config: consumerConfig || null
            };
        } catch (error) {
            if (error.code === 404) {
                throw new Error('Queue not found');
            }
            throw error;
        }
    }

    /**
     * Gera relatório completo de uma fila
     */
    async generateQueueReport(queueName) {
        const consumerConfig = this.activeConsumers.get(queueName);
        if (!consumerConfig) {
            throw new Error(`Queue ${queueName} is not being consumed`);
        }

        return this.messageProcessor.generateQueueReport(queueName, consumerConfig);
    }

    /**
     * Lista todas as filas ativas
     */
    async getActiveQueues() {
        const reports = [];
        
        for (const [queueName, config] of this.activeConsumers.entries()) {
            try {
                const report = await this.generateQueueReport(queueName);
                reports.push(report);
            } catch (error) {
                reports.push({
                    queue: queueName,
                    error: error.message,
                    config
                });
            }
        }
        
        return reports;
    }

    /**
     * Trata reconexão bem-sucedida
     */
    async handleReconnectionSuccess() {
        logger.consumer('Reconnection successful, reestablishing consumers...', {
            consumerCount: this.activeConsumers.size
        });
        
        const consumersToReestablish = Array.from(this.activeConsumers.entries());
        this.activeConsumers.clear();
        this.queueIntervals.clear();
        
        let reestablished = 0;
        let failed = 0;
        
        for (const [queueName, config] of consumersToReestablish) {
            try {
                // Verificar se a fila ainda existe antes de tentar reestabelecer
                await this.rabbitMQService.checkQueue(queueName);
                
                await this.startConsuming(
                    queueName,
                    config.webhook,
                    config.minInterval,
                    config.maxInterval,
                    config.businessHours
                );
                
                // Restaurar estado
                const newConfig = this.activeConsumers.get(queueName);
                if (newConfig) {
                    newConfig.paused = config.paused;
                    newConfig.lastMessage = config.lastMessage;
                    newConfig.messageCount = config.messageCount;
                }
                
                logger.consumer('Reestablished consumer', { queue: queueName });
                reestablished++;
                
            } catch (error) {
                failed++;
                
                if (error.message.includes('does not exist')) {
                    logger.warn('Queue no longer exists, removing from persistence during reconnection', { 
                        queue: queueName 
                    });
                    
                    // Remover da persistência se a fila não existe mais
                    if (this.persistenceService) {
                        try {
                            await this.persistenceService.removeQueueConfig(queueName);
                            logger.info('Removed non-existent queue from persistence', { queue: queueName });
                        } catch (persistError) {
                            logger.error('Failed to remove queue from persistence', persistError, { queue: queueName });
                        }
                    }
                } else {
                    logger.error('Failed to reestablish consumer', error, { queue: queueName });
                }
            }
        }
        
        logger.consumer('Consumer reestablishment completed', { 
            total: consumersToReestablish.length,
            reestablished, 
            failed
        });
        
        this.emit('consumersReestablished', { 
            total: consumersToReestablish.length,
            reestablished, 
            failed 
        });
    }

    /**
     * Trata máximo de tentativas de reconexão alcançado
     */
    handleMaxReconnectionAttempts() {
        logger.error('Maximum reconnection attempts reached, stopping service');
        this.emit('maxReconnectionAttemptsReached');
    }

    /**
     * Trata cancelamento de consumer
     */
    async handleConsumerCancelled(consumerTag) {
        for (const [queueName, config] of this.activeConsumers.entries()) {
            if (config.consumerTag === consumerTag) {
                logger.consumer('Consumer was cancelled externally', { 
                    queue: queueName, 
                    consumerTag 
                });
                
                // Notificar webhook antes de limpar
                try {
                    await this.webhookService.notifyQueueFinish(
                        queueName,
                        config.lastMessage,
                        { reason: 'consumer_cancelled' }
                    );
                } catch (webhookError) {
                    logger.warn('Failed to notify webhook about cancelled consumer', webhookError, { queue: queueName });
                }
                
                // Limpar estado local
                this.activeConsumers.delete(queueName);
                this.queueIntervals.delete(queueName);
                
                // Remover da persistência automaticamente
                if (this.persistenceService) {
                    try {
                        const wasRemoved = await this.persistenceService.removeQueueConfig(queueName);
                        if (wasRemoved) {
                            logger.info('Automatically removed externally cancelled queue from persistence', { 
                                queue: queueName,
                                consumerTag 
                            });
                        }
                    } catch (persistError) {
                        logger.error('Failed to remove externally cancelled queue from persistence', 
                            persistError, { queue: queueName, consumerTag });
                    }
                }
                
                this.emit('consumerCancelled', { queue: queueName, consumerTag });
                break;
            }
        }
    }

    /**
     * Restaura as filas salvas automaticamente
     */
    async restorePersistedQueues() {
        if (!this.persistenceService) {
            logger.info('No persistence service available, skipping queue restoration');
            return { restored: 0, failed: 0, skipped: 0 };
        }

        try {
            logger.consumer('Restoring persisted queue configurations...');
            
            const savedConfigs = await this.persistenceService.loadQueueConfigs();
            const queueNames = Object.keys(savedConfigs);
            
            if (queueNames.length === 0) {
                logger.consumer('No persisted queues found to restore');
                return { restored: 0, failed: 0, skipped: 0 };
            }

            let restored = 0;
            let failed = 0;
            let skipped = 0;
            const toRemove = []; // Filas para remover da persistência

            logger.consumer('Attempting to restore persisted queues...', { total: queueNames.length });
            
            // Abordagem simples: tentar restaurar cada fila diretamente
            for (const queueName of queueNames) {
                try {
                    const config = savedConfigs[queueName];
                    
                    // Verificar se já está sendo consumida
                    if (this.activeConsumers.has(queueName)) {
                        logger.consumer('Queue already being consumed, skipping restoration', { queue: queueName });
                        skipped++;
                        continue;
                    }

                    // Tentar restaurar o consumo diretamente - se a fila não existir, vai falhar
                    logger.consumer('Attempting to restore queue', { queue: queueName });
                    
                    try {
                        await this.startConsuming(
                            queueName,
                            config.webhook,
                            config.minInterval,
                            config.maxInterval,
                            config.businessHours
                        );

                        logger.consumer('Queue restored successfully', { 
                            queue: queueName,
                            webhook: config.webhook 
                        });
                        restored++;

                    } catch (startError) {
                        // Se falhou ao iniciar consumo, provavelmente a fila não existe
                        const errorMessage = startError.message.toLowerCase();
                        
                        if (errorMessage.includes('not_found') || 
                            errorMessage.includes('does not exist') || 
                            errorMessage.includes('no queue') ||
                            startError.code === 404) {
                            
                            logger.warn('Queue no longer exists, marking for removal from persistence', { 
                                queue: queueName, 
                                error: startError.message 
                            });
                            toRemove.push(queueName);
                        } else {
                            logger.error('Failed to restore queue due to other error', startError, { queue: queueName });
                        }
                        
                        failed++;
                    }

                } catch (error) {
                    logger.error('Error during queue restoration', error, { queue: queueName });
                    failed++;
                }
            }

            // Remover filas que não existem mais da persistência
            if (toRemove.length > 0) {
                logger.consumer('Removing non-existent queues from persistence...', { count: toRemove.length });
                
                for (const queueName of toRemove) {
                    try {
                        await this.persistenceService.removeQueueConfig(queueName);
                        logger.info('Successfully removed non-existent queue from persistence', { queue: queueName });
                    } catch (persistError) {
                        logger.error('Failed to remove queue from persistence', persistError, { queue: queueName });
                    }
                }
            }

            const result = { restored, failed, skipped, removed: toRemove.length };
            
            logger.consumer('Queue restoration completed', result);
            this.emit('queuesRestored', result);

            return result;

        } catch (error) {
            logger.error('Failed to restore persisted queues', error);
            return { restored: 0, failed: 0, skipped: 0, error: error.message };
        }
        }

    /**
     * Obtém estatísticas completas
     */
    getStats() {
        return {
            activeConsumers: this.activeConsumers.size,
            isInitialized: this.isInitialized,
            isShuttingDown: this.isShuttingDown,
            healthMonitoring: {
                enabled: this.healthCheckInterval !== null,
                intervalMs: 300000
            },
            messageProcessor: this.messageProcessor.getStats(),
            reconnection: this.reconnectionService.getStats(),
            deduplication: this.deduplicationService.getStats(),
            webhook: this.webhookService.getStats(),
            rabbitmq: {
                isConnected: this.rabbitMQService.isChannelReady()
            },
            persistence: this.persistenceService ? true : false
        };
    }

    /**
     * Shutdown graceful do serviço
     */
    async shutdown() {
        if (this.isShuttingDown) {
            logger.consumer('Shutdown already in progress');
            return;
        }

        this.isShuttingDown = true;
        logger.consumer('Starting graceful shutdown...');

        try {
            // Parar monitoramento de saúde
            this.stopQueueHealthMonitoring();

            // Parar tentativas de reconexão
            await this.reconnectionService.shutdown();

            // Parar todos os consumers
            const activeQueues = Array.from(this.activeConsumers.keys());
            for (const queueName of activeQueues) {
                try {
                    const config = this.activeConsumers.get(queueName);
                    await this.stopConsuming(queueName, 'shutdown');
                    
                    if (config?.lastMessage) {
                        await this.webhookService.notifyQueueFinish(
                            queueName,
                            config.lastMessage,
                            { reason: 'shutdown' }
                        );
                    }
                } catch (error) {
                    logger.error('Error stopping consumer during shutdown', error, { queue: queueName });
                }
            }

            // Shutdown dos serviços
            await this.messageProcessor.shutdown();
            await this.deduplicationService.shutdown();
            await this.webhookService.shutdown();
            await this.rabbitMQService.disconnect();

            logger.consumer('Graceful shutdown completed');
            this.emit('shutdown');

        } catch (error) {
            logger.error('Error during shutdown', error);
            throw error;
        }
    }
}

module.exports = ConsumerService; 