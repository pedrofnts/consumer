const config = require('../config/config');
const logger = require('../utils/logger');
const helpers = require('../utils/helpers');

class QueueController {
    constructor(consumerService) {
        this.consumerService = consumerService;
    }

    /**
     * GET /health - Status de saúde da aplicação
     */
    async getHealth(req, res) {
        try {
            const stats = this.consumerService.getStats();
            const isHealthy = stats.rabbitmq.isConnected && stats.isInitialized;

            if (isHealthy) {
                res.status(200).json({
                    status: 'healthy',
                    timestamp: new Date().toISOString(),
                    stats
                });
            } else {
                res.status(503).json({
                    status: 'unhealthy',
                    timestamp: new Date().toISOString(),
                    stats
                });
            }
        } catch (error) {
            logger.error('Error getting health status', error);
            res.status(500).json({
                status: 'error',
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * POST /consume - Iniciar consumo de uma fila
     */
    async startConsuming(req, res) {
        try {
            const {
                queue,
                webhook,
                minInterval = config.business.defaultIntervals.min,
                maxInterval = config.business.defaultIntervals.max,
                businessHours = config.business.defaultBusinessHours
            } = req.body;

            // Validação básica
            if (!helpers.isValidQueueName(queue)) {
                return res.status(400).json({
                    error: 'Queue name is required and must be a non-empty string'
                });
            }

            if (!helpers.isValidUrl(webhook)) {
                return res.status(400).json({
                    error: 'Invalid webhook URL'
                });
            }

            if (!this.consumerService.isInitialized) {
                return res.status(503).json({
                    error: 'Consumer service not initialized'
                });
            }

            // Verificar se já está sendo consumida
            if (this.consumerService.activeConsumers.has(queue)) {
                return res.status(400).json({
                    error: `Queue ${queue} is already being consumed`
                });
            }

            // Iniciar consumo
            const consumerConfig = await this.consumerService.startConsuming(
                queue,
                webhook,
                minInterval,
                maxInterval,
                businessHours
            );

            logger.api('Started consuming queue via API', {
                queue,
                webhook,
                consumerTag: consumerConfig.consumerTag
            });

            res.status(201).json({
                message: `Started consuming queue ${queue}`,
                config: {
                    queue,
                    webhook,
                    minInterval: consumerConfig.minInterval,
                    maxInterval: consumerConfig.maxInterval,
                    businessHours: consumerConfig.businessHours,
                    consumerTag: consumerConfig.consumerTag,
                    createdAt: consumerConfig.createdAt
                }
            });

        } catch (error) {
            logger.error('Error starting consumer via API', error, { queue: req.body.queue });
            
            if (error.message.includes('Queue') && error.message.includes('does not exist')) {
                res.status(404).json({ error: error.message });
            } else if (error.message.includes('Invalid')) {
                res.status(400).json({ error: error.message });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    }

    /**
     * GET /active-queues - Listar filas ativas
     */
    async getActiveQueues(req, res) {
        try {
            if (!this.consumerService.isInitialized) {
                return res.status(503).json({
                    error: 'Consumer service not initialized'
                });
            }

            const activeQueues = await this.consumerService.getActiveQueues();

            res.json({
                activeQueues,
                count: activeQueues.length,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            logger.error('Error getting active queues', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * GET /queue-info/:queue - Informações de uma fila específica
     */
    async getQueueInfo(req, res) {
        try {
            const { queue } = req.params;

            if (!helpers.isValidQueueName(queue)) {
                return res.status(400).json({
                    error: 'Queue name is required and must be a non-empty string'
                });
            }

            if (!this.consumerService.isInitialized) {
                return res.status(503).json({
                    error: 'Consumer service not initialized'
                });
            }

            const queueInfo = await this.consumerService.getQueueInfo(queue);

            res.json({
                ...queueInfo,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            logger.error('Error getting queue info', error, { queue: req.params.queue });
            
            if (error.message.includes('not found')) {
                res.status(404).json({ error: error.message });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    }

    /**
     * POST /queues-info - Informações de múltiplas filas
     */
    async getQueuesInfo(req, res) {
        try {
            const { queues } = req.body;

            if (!Array.isArray(queues)) {
                return res.status(400).json({
                    error: 'Queues must be an array'
                });
            }

            if (!this.consumerService.isInitialized) {
                return res.status(503).json({
                    error: 'Consumer service not initialized'
                });
            }

            const queuesInfo = await Promise.all(
                queues.map(async (queueName) => {
                    try {
                        const queueInfo = await this.consumerService.getQueueInfo(queueName);
                        return {
                            ...queueInfo,
                            error: null
                        };
                    } catch (error) {
                        return {
                            queue: queueName,
                            error: error.message,
                            messageCount: null,
                            consumerCount: null,
                            isActive: this.consumerService.activeConsumers.has(queueName),
                            config: null
                        };
                    }
                })
            );

            res.json({
                queues: queuesInfo,
                count: queuesInfo.length,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            logger.error('Error getting queues info', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * POST /pause - Pausar consumo de uma fila
     */
    async pauseConsuming(req, res) {
        try {
            const { queue } = req.body;

            if (!helpers.isValidQueueName(queue)) {
                return res.status(400).json({
                    error: 'Queue name is required and must be a non-empty string'
                });
            }

            const consumerConfig = this.consumerService.pauseConsuming(queue);

            logger.api('Paused consumer via API', { queue });

            res.json({
                message: `Queue ${queue} has been paused`,
                config: {
                    queue,
                    paused: consumerConfig.paused,
                    consumerTag: consumerConfig.consumerTag
                }
            });

        } catch (error) {
            logger.error('Error pausing consumer via API', error, { queue: req.body.queue });
            
            if (error.message.includes('not being consumed')) {
                res.status(404).json({ error: error.message });
            } else if (error.message.includes('already paused')) {
                res.status(400).json({ error: error.message });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    }

    /**
     * POST /resume - Retomar consumo de uma fila
     */
    async resumeConsuming(req, res) {
        try {
            const { queue } = req.body;

            if (!helpers.isValidQueueName(queue)) {
                return res.status(400).json({
                    error: 'Queue name is required and must be a non-empty string'
                });
            }

            const consumerConfig = this.consumerService.resumeConsuming(queue);

            logger.api('Resumed consumer via API', { queue });

            res.json({
                message: `Queue ${queue} has been resumed`,
                config: {
                    queue,
                    paused: consumerConfig.paused,
                    consumerTag: consumerConfig.consumerTag
                }
            });

        } catch (error) {
            logger.error('Error resuming consumer via API', error, { queue: req.body.queue });
            
            if (error.message.includes('not being consumed')) {
                res.status(404).json({ error: error.message });
            } else if (error.message.includes('not paused')) {
                res.status(400).json({ error: error.message });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    }

    /**
     * POST /stop - Parar consumo de uma fila
     */
    async stopConsuming(req, res) {
        try {
            const { queue } = req.body;

            if (!helpers.isValidQueueName(queue)) {
                return res.status(400).json({
                    error: 'Queue name is required and must be a non-empty string'
                });
            }

            const consumerConfig = await this.consumerService.stopConsuming(queue, 'api_request');

            logger.api('Stopped consumer via API', {
                queue,
                consumerTag: consumerConfig.consumerTag,
                messageCount: consumerConfig.messageCount
            });

            res.json({
                message: `Queue ${queue} consumption has been stopped`,
                summary: {
                    queue,
                    messageCount: consumerConfig.messageCount,
                    runtime: this._calculateRuntime(consumerConfig.createdAt),
                    consumerTag: consumerConfig.consumerTag
                }
            });

        } catch (error) {
            logger.error('Error stopping consumer via API', error, { queue: req.body.queue });
            
            if (error.message.includes('not being consumed')) {
                res.status(404).json({ error: error.message });
            } else {
                res.status(500).json({ error: error.message });
            }
        }
    }

    /**
     * GET /stats - Estatísticas completas
     */
    async getStats(req, res) {
        try {
            const stats = this.consumerService.getStats();

            res.json({
                ...stats,
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                memoryUsage: process.memoryUsage(),
                version: process.env.npm_package_version || '2.0.0'
            });

        } catch (error) {
            logger.error('Error getting stats', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * POST /webhook/test - Testar conectividade de webhook
     */
    async testWebhook(req, res) {
        try {
            const { url, timeout = 5000 } = req.body;

            if (!helpers.isValidUrl(url)) {
                return res.status(400).json({
                    error: 'Invalid webhook URL'
                });
            }

            const result = await this.consumerService.webhookService.testWebhook(url, { timeout });

            if (result.success) {
                res.json({
                    success: true,
                    message: 'Webhook is responsive',
                    responseTime: result.responseTime,
                    status: result.status
                });
            } else {
                res.status(400).json({
                    success: false,
                    message: 'Webhook test failed',
                    error: result.error,
                    responseTime: result.responseTime,
                    status: result.status
                });
            }

        } catch (error) {
            logger.error('Error testing webhook', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }

    /**
     * POST /stats/reset - Resetar estatísticas
     */
    async resetStats(req, res) {
        try {
            this.consumerService.messageProcessor.resetStats();

            logger.api('Statistics reset via API');

            res.json({
                message: 'Statistics have been reset',
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            logger.error('Error resetting stats', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * GET /persisted-queues - Listar configurações de filas salvas
     */
    async getPersistedQueues(req, res) {
        try {
            if (!this.consumerService.persistenceService) {
                return res.status(503).json({
                    error: 'Persistence service not available'
                });
            }

            const configs = await this.consumerService.persistenceService.loadQueueConfigs();
            const stats = await this.consumerService.persistenceService.getStats();

            res.json({
                persisted: configs,
                stats,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            logger.error('Error getting persisted queues', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * POST /restore-queues - Restaurar filas salvas manualmente
     */
    async restoreQueues(req, res) {
        try {
            if (!this.consumerService.persistenceService) {
                return res.status(503).json({
                    error: 'Persistence service not available'
                });
            }

            const result = await this.consumerService.restorePersistedQueues();

            logger.api('Manual queue restoration via API', result);

            res.json({
                message: 'Queue restoration completed',
                result,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            logger.error('Error restoring queues', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * POST /backup-configs - Criar backup das configurações
     */
    async createBackup(req, res) {
        try {
            if (!this.consumerService.persistenceService) {
                return res.status(503).json({
                    error: 'Persistence service not available'
                });
            }

            const { path: backupPath } = req.body;
            const backupFile = await this.consumerService.persistenceService.createBackup(backupPath);

            logger.api('Configuration backup created via API', { backupFile });

            res.json({
                message: 'Backup created successfully',
                backupFile,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            logger.error('Error creating backup', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * POST /restore-backup - Restaurar configurações de um backup
     */
    async restoreFromBackup(req, res) {
        try {
            if (!this.consumerService.persistenceService) {
                return res.status(503).json({
                    error: 'Persistence service not available'
                });
            }

            const { backupPath } = req.body;

            if (!backupPath) {
                return res.status(400).json({
                    error: 'Backup path is required'
                });
            }

            const restoredQueues = await this.consumerService.persistenceService.restoreFromBackup(backupPath);

            logger.api('Configuration restored from backup via API', { 
                backupPath, 
                queues: restoredQueues.length 
            });

            res.json({
                message: 'Configuration restored successfully',
                restoredQueues,
                count: restoredQueues.length,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            logger.error('Error restoring from backup', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * DELETE /clear-configs - Limpar todas as configurações salvas
     */
    async clearPersistedConfigs(req, res) {
        try {
            if (!this.consumerService.persistenceService) {
                return res.status(503).json({
                    error: 'Persistence service not available'
                });
            }

            await this.consumerService.persistenceService.clearAll();

            logger.api('All persisted configurations cleared via API');

            res.json({
                message: 'All persisted configurations cleared',
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            logger.error('Error clearing persisted configs', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * POST /cleanup-orphans - Limpar configurações órfãs (filas que não existem mais)
     */
    async cleanupOrphanedConfigs(req, res) {
        try {
            if (!this.consumerService.persistenceService) {
                return res.status(503).json({
                    error: 'Persistence service not available'
                });
            }

            const persistedConfigs = await this.consumerService.persistenceService.loadQueueConfigs();
            const queueNames = Object.keys(persistedConfigs);
            
            if (queueNames.length === 0) {
                return res.json({
                    message: 'No persisted configurations found',
                    removedQueues: [],
                    count: 0,
                    timestamp: new Date().toISOString()
                });
            }

            const removedQueues = [];
            let checkedCount = 0;

            logger.api('Starting orphaned configurations cleanup', { totalQueues: queueNames.length });

            for (const queueName of queueNames) {
                checkedCount++;
                
                // Verificação simples - tentar verificar a fila diretamente
                let queueExists = true;
                try {
                    await this.consumerService.rabbitMQService.checkQueue(queueName);
                } catch (error) {
                    const errorMessage = error.message.toLowerCase();
                    
                    if (errorMessage.includes('not_found') || 
                        errorMessage.includes('does not exist') || 
                        errorMessage.includes('no queue') ||
                        (error.code && error.code === 404)) {
                        queueExists = false;
                    }
                    // Para outros erros, assumir que existe para evitar remoção incorreta
                }
                
                if (!queueExists) {
                    try {
                        await this.consumerService.persistenceService.removeQueueConfig(queueName);
                        removedQueues.push({
                            queue: queueName,
                            webhook: persistedConfigs[queueName]?.webhook,
                            removedAt: new Date().toISOString()
                        });
                        logger.api('Removed orphaned queue configuration', { queue: queueName });
                    } catch (removeError) {
                        logger.error('Failed to remove orphaned queue configuration', removeError, { queue: queueName });
                    }
                }
            }

            logger.api('Orphaned configurations cleanup completed', { 
                checked: checkedCount, 
                removed: removedQueues.length 
            });

            res.json({
                message: 'Orphaned configurations cleanup completed',
                checked: checkedCount,
                removedQueues,
                count: removedQueues.length,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            logger.error('Error cleaning up orphaned configs', error);
            res.status(500).json({ error: error.message });
        }
    }

    /**
     * DELETE /persisted-queue/:queue - Remover configuração de uma fila específica
     */
    async removePersistedQueue(req, res) {
        try {
            if (!this.consumerService.persistenceService) {
                return res.status(503).json({
                    error: 'Persistence service not available'
                });
            }

            const { queue: queueName } = req.params;
            
            if (!queueName) {
                return res.status(400).json({
                    error: 'Queue name is required'
                });
            }

            // Verificar se a configuração existe
            const existingConfig = await this.consumerService.persistenceService.loadQueueConfig(queueName);
            
            if (!existingConfig) {
                return res.status(404).json({
                    error: 'Queue configuration not found',
                    queue: queueName
                });
            }

            // Remover a configuração
            const wasRemoved = await this.consumerService.persistenceService.removeQueueConfig(queueName);

            if (wasRemoved) {
                logger.api('Queue configuration removed via API', { 
                    queue: queueName,
                    webhook: existingConfig.webhook 
                });

                res.json({
                    message: 'Queue configuration removed successfully',
                    queue: queueName,
                    removedConfig: existingConfig,
                    timestamp: new Date().toISOString()
                });
            } else {
                res.status(404).json({
                    error: 'Queue configuration not found or already removed',
                    queue: queueName
                });
            }

        } catch (error) {
            logger.error('Error removing persisted queue', error, { queue: req.params.queue });
            res.status(500).json({ error: error.message });
        }
    }


    /**
     * Calcula tempo de execução
     */
    _calculateRuntime(createdAt) {
        if (!createdAt) return null;
        
        const start = new Date(createdAt);
        const now = new Date();
        const runtimeMs = now - start;
        
        return helpers.formatEstimatedTime(runtimeMs);
    }

    /**
     * Middleware de tratamento de erros
     */
    errorHandler(error, req, res, next) {
        logger.error('API error', error, {
            path: req.path,
            method: req.method,
            body: req.body,
            params: req.params
        });

        if (res.headersSent) {
            return next(error);
        }

        res.status(500).json({
            error: 'Internal server error',
            timestamp: new Date().toISOString(),
            path: req.path
        });
    }
}

module.exports = QueueController; 