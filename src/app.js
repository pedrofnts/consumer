const express = require('express');
const config = require('./config/config');
const logger = require('./utils/logger');

// Serviços
const RabbitMQService = require('./services/RabbitMQService');
const DeduplicationService = require('./services/DeduplicationService');
const ReconnectionService = require('./services/ReconnectionService');
const WebhookService = require('./services/WebhookService');
const MessageProcessor = require('./services/MessageProcessor');
const ConsumerService = require('./services/ConsumerService');
const PersistenceService = require('./services/PersistenceService');

// Controllers e Routes
const QueueController = require('./controllers/QueueController');
const setupQueueRoutes = require('./routes/queueRoutes');

// Middleware
const requestLogger = require('./middleware/requestLogger');

class RabbitMQConsumerApp {
    constructor() {
        this.app = express();
        this.server = null;
        this.services = {};
        this.isShuttingDown = false;
        
        this.setupServices();
        this.setupExpress();
        this.setupRoutes();
        this.setupErrorHandling();
        this.setupGracefulShutdown();
    }

    /**
     * Inicializa todos os serviços
     */
    setupServices() {
        logger.info('Setting up services...');

        // Serviços básicos
        this.services.rabbitmq = new RabbitMQService();
        this.services.deduplication = new DeduplicationService();
        this.services.webhook = new WebhookService();
        this.services.persistence = new PersistenceService();

        // Serviços que dependem de outros
        this.services.reconnection = new ReconnectionService(this.services.rabbitmq);
        this.services.messageProcessor = new MessageProcessor(
            this.services.webhook,
            this.services.deduplication,
            this.services.rabbitmq
        );

        // Serviço principal
        this.services.consumer = new ConsumerService(
            this.services.rabbitmq,
            this.services.reconnection,
            this.services.messageProcessor,
            this.services.webhook,
            this.services.deduplication,
            this.services.persistence
        );

        // Controller
        this.controller = new QueueController(this.services.consumer);

        logger.info('Services setup complete');
    }

    /**
     * Configura o Express
     */
    setupExpress() {
        // Middleware básico
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

        // Request logging
        this.app.use(requestLogger);

        // Security headers
        this.app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('X-XSS-Protection', '1; mode=block');
            next();
        });
    }

    /**
     * Configura as rotas
     */
    setupRoutes() {
        // Usar as rotas
        this.app.use('/', setupQueueRoutes(this.controller));

        // Rota root
        this.app.get('/', (req, res) => {
            res.json({
                name: 'RabbitMQ Consumer API',
                version: '2.0.0',
                status: 'running',
                timestamp: new Date().toISOString(),
                endpoints: {
                    health: 'GET /health',
                    consume: 'POST /consume',
                    activeQueues: 'GET /active-queues',
                    queueInfo: 'GET /queue-info/:queue',
                    queuesInfo: 'POST /queues-info',
                    pause: 'POST /pause',
                    resume: 'POST /resume',
                    stop: 'POST /stop',
                    stats: 'GET /stats',
                    resetStats: 'POST /stats/reset',
                    testWebhook: 'POST /webhook/test',
                    persistedQueues: 'GET /persisted-queues',
                    restoreQueues: 'POST /restore-queues',
                    backupConfigs: 'POST /backup-configs',
                    restoreBackup: 'POST /restore-backup',
                    clearConfigs: 'DELETE /clear-configs'
                }
            });
        });

        // 404 handler
        this.app.use('*', (req, res) => {
            res.status(404).json({
                error: 'Endpoint not found',
                path: req.originalUrl,
                method: req.method,
                timestamp: new Date().toISOString()
            });
        });
    }

    /**
     * Configura tratamento de erros
     */
    setupErrorHandling() {
        this.app.use(this.controller.errorHandler.bind(this.controller));

        // Capturar erros não tratados
        process.on('uncaughtException', (error) => {
            logger.error('Uncaught Exception', error);
            if (!this.isShuttingDown) {
                this.gracefulShutdown('uncaughtException');
            }
        });

        process.on('unhandledRejection', (reason, promise) => {
            logger.error('Unhandled Rejection', new Error(reason), {
                promise: promise.toString()
            });
            if (!this.isShuttingDown) {
                this.gracefulShutdown('unhandledRejection');
            }
        });
    }

    /**
     * Configura graceful shutdown
     */
    setupGracefulShutdown() {
        const shutdownHandler = (signal) => {
            logger.info(`Received ${signal}, starting graceful shutdown...`);
            this.gracefulShutdown(signal);
        };

        process.on('SIGINT', shutdownHandler);
        process.on('SIGTERM', shutdownHandler);
    }

    /**
     * Inicia a aplicação
     */
    async start() {
        try {
            logger.info('Starting RabbitMQ Consumer Application...');

            // Inicializar serviço principal
            await this.services.consumer.initialize();

            // Iniciar servidor HTTP
            await this.startServer();

            logger.info('Application started successfully', {
                port: config.api.port,
                pid: process.pid,
                nodeVersion: process.version,
                platform: process.platform
            });

        } catch (error) {
            logger.error('Failed to start application', error);
            process.exit(1);
        }
    }

    /**
     * Inicia o servidor HTTP
     */
    async startServer() {
        return new Promise((resolve, reject) => {
            this.server = this.app.listen(config.api.port, (error) => {
                if (error) {
                    reject(error);
                } else {
                    logger.info(`HTTP server listening on port ${config.api.port}`);
                    resolve();
                }
            });

            this.server.on('error', (error) => {
                if (error.code === 'EADDRINUSE') {
                    logger.error(`Port ${config.api.port} is already in use`);
                } else {
                    logger.error('Server error', error);
                }
                reject(error);
            });
        });
    }

    /**
     * Graceful shutdown
     */
    async gracefulShutdown(reason = 'unknown') {
        if (this.isShuttingDown) {
            logger.warn('Shutdown already in progress');
            return;
        }

        this.isShuttingDown = true;
        logger.info(`Starting graceful shutdown (reason: ${reason})...`);

        const shutdownTimeout = setTimeout(() => {
            logger.error('Graceful shutdown timed out, forcing exit');
            process.exit(1);
        }, 30000); // 30 seconds timeout

        try {
            // Parar de aceitar novas conexões
            if (this.server) {
                logger.info('Closing HTTP server...');
                await new Promise((resolve) => {
                    this.server.close(resolve);
                });
                logger.info('HTTP server closed');
            }

            // Shutdown dos serviços
            if (this.services.consumer) {
                logger.info('Shutting down consumer service...');
                await this.services.consumer.shutdown();
                logger.info('Consumer service shutdown complete');
            }

            clearTimeout(shutdownTimeout);
            logger.info('Graceful shutdown completed successfully');
            process.exit(0);

        } catch (error) {
            clearTimeout(shutdownTimeout);
            logger.error('Error during graceful shutdown', error);
            process.exit(1);
        }
    }

    /**
     * Obtém estatísticas da aplicação
     */
    getAppStats() {
        return {
            uptime: process.uptime(),
            memoryUsage: process.memoryUsage(),
            cpuUsage: process.cpuUsage(),
            pid: process.pid,
            platform: process.platform,
            nodeVersion: process.version,
            isShuttingDown: this.isShuttingDown,
            services: this.services.consumer ? this.services.consumer.getStats() : null
        };
    }
}

module.exports = RabbitMQConsumerApp; 