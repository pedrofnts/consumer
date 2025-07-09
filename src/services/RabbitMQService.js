const amqp = require('amqplib');
const EventEmitter = require('events');
const config = require('../config/config');
const logger = require('../utils/logger');

class RabbitMQService extends EventEmitter {
    constructor() {
        super();
        this.connection = null;
        this.channel = null;
        this.isConnecting = false;
        this.shuttingDown = false;
    }

    /**
     * Verifica se o canal está disponível e funcionando
     */
    isChannelReady() {
        return this.channel && 
               !this.channel.closing && 
               !this.channel.closed &&
               this.connection && 
               !this.connection.closing &&
               !this.connection.closed &&
               !this.shuttingDown;
    }

    /**
     * Conecta ao RabbitMQ
     */
    async connect() {
        if (this.isConnecting) {
            throw new Error('Connection already in progress');
        }

        this.isConnecting = true;

        try {
            logger.rabbitmq('Connecting to RabbitMQ...');
            
            this.connection = await amqp.connect(config.rabbitmq.url, {
                heartbeat: config.rabbitmq.heartbeat,
                connection_timeout: config.rabbitmq.connectionTimeout
            });
            
            this.channel = await this.connection.createChannel();
            await this.channel.prefetch(config.rabbitmq.prefetch);
            
            this._setupEventHandlers();
            
            logger.rabbitmq('Connected to RabbitMQ successfully');
            this.emit('connected');
            
        } catch (error) {
            logger.error('Failed to connect to RabbitMQ', error);
            throw error;
        } finally {
            this.isConnecting = false;
        }
    }

    /**
     * Configura event handlers para conexão e canal
     */
    _setupEventHandlers() {
        // Connection event handlers
        this.connection.on('error', (err) => {
            logger.error('RabbitMQ connection error', err);
            this.emit('connectionError', err);
        });

        this.connection.on('close', () => {
            logger.warn('RabbitMQ connection closed');
            this.emit('connectionClosed');
        });
        
        // Channel event handlers
        this.channel.on('error', (err) => {
            logger.error('RabbitMQ channel error', err);
            this.emit('channelError', err);
        });

        this.channel.on('close', () => {
            logger.warn('RabbitMQ channel closed');
            this.emit('channelClosed');
        });

        this.channel.on('cancel', (consumerTag) => {
            logger.warn('Consumer cancelled', { consumerTag });
            this.emit('consumerCancelled', consumerTag);
        });
    }

    /**
     * Executa operação no canal de forma segura
     */
    async safeChannelOperation(operation, errorMessage = 'Channel operation failed') {
        // ✅ MELHORIA: Verificação proativa antes da operação
        if (!this.isChannelReady()) {
            const channelError = new Error('Channel not ready');
            logger.debug('Channel not ready for operation', { 
                operation: errorMessage,
                connectionClosed: this.connection?.closed,
                channelClosed: this.channel?.closed
            });
            
            // Disparar verificação de reconexão se canal não estiver pronto
            setImmediate(() => this.emit('needsReconnection', channelError));
            throw channelError;
        }

        try {
            return await operation();
        } catch (error) {
            // ✅ MELHORIA: Logging mais inteligente
            if (error.message.includes('delivery tag')) {
                // Erro de delivery tag já tratado em outro lugar
                logger.debug('Delivery tag error (handled safely)', { 
                    operation: errorMessage, 
                    error: error.message 
                });
            } else {
                logger.error(errorMessage, error);
            }
            
            // Detectar erros específicos que requerem reconexão
            if (this._shouldTriggerReconnection(error)) {
                logger.warn('Operation error requires reconnection', { 
                    operation: errorMessage, 
                    error: error.message 
                });
                setImmediate(() => this.emit('needsReconnection', error));
            }
            
            throw error;
        }
    }

    /**
     * Verifica se o erro deve disparar reconexão
     */
    _shouldTriggerReconnection(error) {
        // Erros que indicam problemas de conexão/canal (devem disparar reconexão)
        const connectionErrors = [
            'Channel closed',
            'Connection closed',
            'Connection lost',
            'Socket closed',
            'ECONNRESET',
            'ENOTFOUND',
            'ETIMEDOUT'
        ];
        
        // Erros específicos do protocolo AMQP que afetam o canal
        const protocolErrors = [
            // ✅ CORREÇÃO: Delivery tag duplicado NÃO deve disparar reconexão
            // É comportamento normal quando mensagens duplicadas são detectadas
            // error.code === 406 && error.message.includes('delivery tag'), 
            error.code === 504, // CHANNEL_ERROR
            error.code === 505, // UNEXPECTED_FRAME
            error.code === 506  // RESOURCE_ERROR
        ];
        
        // Erros de fila que NÃO devem disparar reconexão
        const queueSpecificErrors = [
            error.code === 404 && error.message.includes('NOT_FOUND'),
            error.message.includes('does not exist'),
            error.code === 403 // ACCESS_REFUSED para fila específica
        ];
        
        // Se é erro específico de fila, não reconectar
        if (queueSpecificErrors.some(condition => condition)) {
            return false;
        }
        
        // Se é erro de protocolo, reconectar
        if (protocolErrors.some(condition => condition)) {
            return true;
        }
        
        // Se é erro de conexão, reconectar
        return connectionErrors.some(errorPattern => 
            error.message.includes(errorPattern)
        );
    }

    /**
     * Verifica se uma fila existe
     */
    async checkQueue(queueName) {
        return this.safeChannelOperation(
            () => this.channel.checkQueue(queueName),
            `Error checking queue ${queueName}`
        );
    }

    /**
     * Cria um consumer para uma fila
     */
    async createConsumer(queueName, messageHandler, options = {}) {
        return this.safeChannelOperation(
            () => this.channel.consume(queueName, messageHandler, options),
            `Error creating consumer for queue ${queueName}`
        );
    }

    /**
     * Cancela um consumer
     */
    async cancelConsumer(consumerTag) {
        return this.safeChannelOperation(
            () => this.channel.cancel(consumerTag),
            `Error cancelling consumer ${consumerTag}`
        );
    }

    /**
     * ACK de mensagem de forma segura
     */
    async ackMessage(msg) {
        if (!msg) return;
        
        try {
            if (this.isChannelReady()) {
                this.channel.ack(msg);
            }
        } catch (error) {
            // ✅ Proteção específica para delivery tag já usado
            if (error.code === 406 && error.message.includes('delivery tag')) {
                logger.debug('ACK ignored: delivery tag already used', { 
                    deliveryTag: msg.fields?.deliveryTag,
                    error: error.message 
                });
                return; // Não propagar erro nem disparar reconexão
            }
            
            // Outros erros são tratados normalmente (channel fechado, etc.)
        }
    }

    /**
     * NACK de mensagem de forma segura
     */
    async nackMessage(msg, allUpTo = false, requeue = true) {
        if (!msg) return;
        
        try {
            if (this.isChannelReady()) {
                this.channel.nack(msg, allUpTo, requeue);
            }
        } catch (error) {
            // ✅ Proteção específica para delivery tag já usado
            if (error.code === 406 && error.message.includes('delivery tag')) {
                logger.debug('NACK ignored: delivery tag already used', { 
                    deliveryTag: msg.fields?.deliveryTag,
                    error: error.message 
                });
                return; // Não propagar erro nem disparar reconexão
            }
            
            // Outros erros são tratados normalmente (channel fechado, etc.)
        }
    }

    /**
     * Fecha conexão de forma segura
     */
    async disconnect() {
        this.shuttingDown = true;
        
        try {
            if (this.channel && !this.channel.closed && !this.channel.closing) {
                await this.channel.close();
                logger.rabbitmq('Channel closed');
            }
        } catch (error) {
            logger.error('Error closing channel', error);
        }
        
        try {
            if (this.connection && !this.connection.closed && !this.connection.closing) {
                await this.connection.close();
                logger.rabbitmq('Connection closed');
            }
        } catch (error) {
            logger.error('Error closing connection', error);
        }
        
        this.connection = null;
        this.channel = null;
        this.emit('disconnected');
    }

    /**
     * Limpa estado interno
     */
    cleanup() {
        this.connection = null;
        this.channel = null;
        this.isConnecting = false;
        this.removeAllListeners();
    }
}

module.exports = RabbitMQService; 