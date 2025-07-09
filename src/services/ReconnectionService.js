const EventEmitter = require('events');
const config = require('../config/config');
const logger = require('../utils/logger');
const helpers = require('../utils/helpers');

class ReconnectionService extends EventEmitter {
    constructor(rabbitMQService) {
        super();
        this.rabbitMQService = rabbitMQService;
        this.isReconnecting = false;
        this.reconnectAttempts = 0;
        this.lastReconnectTime = 0;
        this.reconnectTimeout = null;
        this.shuttingDown = false;
        
        // Configurações
        this.maxAttempts = config.reconnection.maxAttempts;
        this.baseDelay = config.reconnection.baseDelay;
        this.maxDelay = config.reconnection.maxDelay;
        this.debounceMs = config.reconnection.debounceMs;
        this.backoffMultiplier = config.reconnection.backoffMultiplier;
        
        this.setupEventHandlers();
    }

    /**
     * Configura event handlers do RabbitMQ
     */
    setupEventHandlers() {
        this.rabbitMQService.on('connectionError', (error) => {
            this.handleConnectionError(error);
        });

        this.rabbitMQService.on('connectionClosed', () => {
            this.handleConnectionClosed();
        });

        this.rabbitMQService.on('channelError', (error) => {
            this.handleChannelError(error);
        });

        this.rabbitMQService.on('channelClosed', () => {
            this.handleChannelClosed();
        });

        this.rabbitMQService.on('needsReconnection', (error) => {
            this.handleNeedsReconnection(error);
        });
    }

    /**
     * Trata erro de conexão
     */
    handleConnectionError(error) {
        logger.reconnection('Connection error detected', { error: error.message });
        if (!this.shuttingDown) {
            this.scheduleReconnection('connection-error');
        }
    }

    /**
     * Trata fechamento de conexão
     */
    handleConnectionClosed() {
        logger.reconnection('Connection closed detected');
        if (!this.shuttingDown) {
            this.scheduleReconnection('connection-closed');
        }
    }

    /**
     * Trata erro de canal
     */
    handleChannelError(error) {
        logger.reconnection('Channel error detected', { error: error.message });
        if (!this.shuttingDown) {
            this.scheduleReconnection('channel-error');
        }
    }

    /**
     * Trata fechamento de canal
     */
    handleChannelClosed() {
        logger.reconnection('Channel closed detected');
        if (!this.shuttingDown) {
            this.scheduleReconnection('channel-closed');
        }
    }

    /**
     * Trata sinal de necessidade de reconexão
     */
    handleNeedsReconnection(error) {
        logger.reconnection('Reconnection needed signal received', { error: error.message });
        if (!this.shuttingDown) {
            this.scheduleReconnection('needs-reconnection');
        }
    }

    /**
     * Verifica se deve tentar reconectar
     */
    shouldAttemptReconnection() {
        if (this.shuttingDown) {
            logger.reconnection('Skipping reconnection: shutting down');
            return false;
        }

        if (this.isReconnecting) {
            logger.reconnection('Skipping reconnection: already in progress');
            return false;
        }

        const now = Date.now();
        const timeSinceLastReconnect = now - this.lastReconnectTime;
        
        if (timeSinceLastReconnect < this.debounceMs) {
            logger.reconnection('Skipping reconnection: debounce active', {
                timeSinceLastMs: timeSinceLastReconnect,
                debounceMs: this.debounceMs
            });
            return false;
        }
        
        if (this.reconnectAttempts >= this.maxAttempts) {
            logger.error('Max reconnection attempts reached', null, {
                attempts: this.reconnectAttempts,
                maxAttempts: this.maxAttempts
            });
            this.emit('maxAttemptsReached');
            return false;
        }
        
        return true;
    }

    /**
     * Agenda uma tentativa de reconexão
     */
    scheduleReconnection(reason = 'unknown') {
        if (!this.shouldAttemptReconnection()) {
            return;
        }

        // Cancelar timeout anterior se existir
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }

        const delay = helpers.calculateBackoffDelay(this.reconnectAttempts + 1);
        
        logger.reconnection('Scheduling reconnection', {
            reason,
            delayMs: delay,
            attempt: this.reconnectAttempts + 1,
            maxAttempts: this.maxAttempts
        });

        this.reconnectTimeout = setTimeout(() => {
            this.attemptReconnection();
        }, delay);
    }

    /**
     * Tenta reconectar
     */
    async attemptReconnection() {
        if (!this.shouldAttemptReconnection()) {
            return;
        }

        this.lastReconnectTime = Date.now();
        this.isReconnecting = true;
        this.reconnectAttempts++;

        logger.reconnection('Starting reconnection attempt', {
            attempt: this.reconnectAttempts,
            maxAttempts: this.maxAttempts
        });

        this.emit('reconnectionStarted', {
            attempt: this.reconnectAttempts,
            maxAttempts: this.maxAttempts
        });

        try {
            // Cleanup do estado anterior
            await this.cleanupPreviousConnection();
            
            // Aguardar um pouco antes de tentar reconectar
            await helpers.sleep(1000);
            
            // Tentar nova conexão
            await this.rabbitMQService.connect();
            
            // Sucesso!
            logger.reconnection('Reconnection successful', {
                attempt: this.reconnectAttempts,
                totalTimeMs: Date.now() - this.lastReconnectTime
            });
            
            this.resetReconnectionState();
            this.emit('reconnectionSuccessful', {
                attempt: this.reconnectAttempts
            });
            
        } catch (error) {
            logger.error('Reconnection attempt failed', error, {
                attempt: this.reconnectAttempts,
                maxAttempts: this.maxAttempts
            });
            
            this.emit('reconnectionFailed', {
                attempt: this.reconnectAttempts,
                error: error.message
            });
            
            // Agendar próxima tentativa
            this.scheduleReconnection('retry-after-failure');
            
        } finally {
            this.isReconnecting = false;
        }
    }

    /**
     * Limpa conexão anterior
     */
    async cleanupPreviousConnection() {
        logger.reconnection('Cleaning up previous connection state');
        
        try {
            this.rabbitMQService.cleanup();
        } catch (error) {
            logger.warn('Error during connection cleanup', { error: error.message });
        }
    }

    /**
     * Reseta estado de reconexão após sucesso
     */
    resetReconnectionState() {
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        
        logger.reconnection('Reconnection state reset');
    }

    /**
     * Para tentativas de reconexão
     */
    stopReconnectionAttempts() {
        logger.reconnection('Stopping reconnection attempts');
        
        this.shuttingDown = true;
        
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        
        this.isReconnecting = false;
    }

    /**
     * Força uma tentativa de reconexão imediata
     */
    async forceReconnection() {
        logger.reconnection('Forcing immediate reconnection');
        
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        
        await this.attemptReconnection();
    }

    /**
     * Obtém estatísticas do serviço
     */
    getStats() {
        return {
            isReconnecting: this.isReconnecting,
            reconnectAttempts: this.reconnectAttempts,
            maxAttempts: this.maxAttempts,
            lastReconnectTime: this.lastReconnectTime,
            shuttingDown: this.shuttingDown,
            timeSinceLastReconnectMs: Date.now() - this.lastReconnectTime,
            hasScheduledReconnection: !!this.reconnectTimeout,
            config: {
                baseDelay: this.baseDelay,
                maxDelay: this.maxDelay,
                debounceMs: this.debounceMs,
                backoffMultiplier: this.backoffMultiplier
            }
        };
    }

    /**
     * Shutdown graceful do serviço
     */
    async shutdown() {
        logger.reconnection('Shutting down reconnection service');
        
        this.stopReconnectionAttempts();
        this.removeAllListeners();
        
        logger.reconnection('Reconnection service shutdown complete');
    }
}

module.exports = ReconnectionService; 