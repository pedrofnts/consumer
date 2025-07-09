const config = require('../config/config');
const logger = require('../utils/logger');
const helpers = require('../utils/helpers');

class DeduplicationService {
    constructor() {
        this.processedMessages = new Set();
        this.processingMessages = new Map();
        this.cleanupInterval = null;
        this.maxProcessedMessages = config.deduplication.maxProcessedMessages;
        this.cleanupIntervalMs = config.deduplication.cleanupIntervalMs;
        
        this.startCleanupProcess();
    }

    /**
     * Inicia processo de limpeza automática
     */
    startCleanupProcess() {
        this.cleanupInterval = setInterval(() => {
            this.cleanupOldMessages();
        }, this.cleanupIntervalMs);

        logger.debug('Deduplication cleanup process started', {
            intervalMs: this.cleanupIntervalMs,
            maxMessages: this.maxProcessedMessages
        });
    }

    /**
     * Para processo de limpeza
     */
    stopCleanupProcess() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            logger.debug('Deduplication cleanup process stopped');
        }
    }

    /**
     * Limpa mensagens antigas do cache
     */
    cleanupOldMessages() {
        const currentSize = this.processedMessages.size;
        
        if (currentSize > this.maxProcessedMessages) {
            const toDelete = currentSize - this.maxProcessedMessages;
            const messagesToDelete = Array.from(this.processedMessages).slice(0, toDelete);
            
            messagesToDelete.forEach(messageId => {
                this.processedMessages.delete(messageId);
            });

            logger.debug('Cleaned up old processed messages', {
                deleted: toDelete,
                remaining: this.processedMessages.size
            });
        }
    }

    /**
     * Gera ID único para uma mensagem
     */
    generateMessageId(msg) {
        return helpers.generateMessageId(msg);
    }

    /**
     * Verifica se uma mensagem já foi processada
     */
    isMessageProcessed(messageId) {
        if (!messageId) return false;
        
        const isProcessed = this.processedMessages.has(messageId);
        
        // ✅ Log detalhado para debug de duplicação
        if (isProcessed) {
            logger.debug('Duplicate message detected', { 
                messageId,
                totalProcessed: this.processedMessages.size,
                isCurrentlyProcessing: this.processingMessages.has(messageId)
            });
        }
        
        return isProcessed;
    }

    /**
     * Marca uma mensagem como processada
     */
    markMessageProcessed(messageId) {
        if (!messageId) return false;
        
        this.processedMessages.add(messageId);
        
        logger.debug('Message marked as processed', { 
            messageId,
            totalProcessed: this.processedMessages.size 
        });
        
        return true;
    }

    /**
     * Verifica se uma mensagem está sendo processada atualmente
     */
    isMessageProcessing(messageId) {
        if (!messageId) return false;
        return this.processingMessages.has(messageId);
    }

    /**
     * Marca uma mensagem como em processamento
     */
    markMessageProcessing(messageId, metadata = {}) {
        if (!messageId) return false;

        const processingInfo = {
            startTime: Date.now(),
            ...metadata
        };

        this.processingMessages.set(messageId, processingInfo);
        
        logger.debug('Message marked as processing', { 
            messageId,
            metadata: processingInfo,
            totalProcessing: this.processingMessages.size 
        });
        
        return true;
    }

    /**
     * Remove uma mensagem do estado de processamento
     */
    removeMessageFromProcessing(messageId) {
        if (!messageId) return false;

        const processingInfo = this.processingMessages.get(messageId);
        const removed = this.processingMessages.delete(messageId);
        
        if (removed && processingInfo) {
            const processingTime = Date.now() - processingInfo.startTime;
            logger.debug('Message removed from processing', { 
                messageId,
                processingTimeMs: processingTime,
                totalProcessing: this.processingMessages.size 
            });
        }
        
        return removed;
    }

    /**
     * Obtém estatísticas do serviço
     */
    getStats() {
        return {
            processedMessages: this.processedMessages.size,
            processingMessages: this.processingMessages.size,
            maxProcessedMessages: this.maxProcessedMessages,
            cleanupIntervalMs: this.cleanupIntervalMs,
            memoryUsage: {
                processedSetSize: this.processedMessages.size,
                processingMapSize: this.processingMessages.size,
                estimatedMemoryKB: Math.round(
                    (this.processedMessages.size + this.processingMessages.size) * 50 / 1024
                )
            }
        };
    }

    /**
     * Limpa todo o cache (útil para testes ou reset)
     */
    clear() {
        this.processedMessages.clear();
        this.processingMessages.clear();
        logger.debug('Deduplication cache cleared');
    }

    /**
     * Obtém mensagens que estão processando há muito tempo
     */
    getStaleProcessingMessages(maxAgeMs = 300000) { // 5 minutes default
        const now = Date.now();
        const staleMessages = [];

        for (const [messageId, info] of this.processingMessages.entries()) {
            const age = now - info.startTime;
            if (age > maxAgeMs) {
                staleMessages.push({
                    messageId,
                    ageMs: age,
                    metadata: info
                });
            }
        }

        return staleMessages;
    }

    /**
     * Remove mensagens stale do processamento
     */
    cleanupStaleProcessingMessages(maxAgeMs = 300000) {
        const staleMessages = this.getStaleProcessingMessages(maxAgeMs);
        
        staleMessages.forEach(({ messageId, ageMs }) => {
            this.removeMessageFromProcessing(messageId);
            logger.warn('Removed stale processing message', { 
                messageId, 
                ageMs,
                ageMinutes: Math.round(ageMs / 60000) 
            });
        });

        return staleMessages.length;
    }

    /**
     * Shutdown graceful do serviço
     */
    async shutdown() {
        logger.info('Shutting down deduplication service...');
        
        this.stopCleanupProcess();
        
        // Aguardar mensagens em processamento por um tempo
        const maxWaitTime = 30000; // 30 segundos
        const checkInterval = 1000; // 1 segundo
        let waitTime = 0;

        while (this.processingMessages.size > 0 && waitTime < maxWaitTime) {
            logger.info(`Waiting for ${this.processingMessages.size} messages to finish processing...`);
            await helpers.sleep(checkInterval);
            waitTime += checkInterval;
        }

        if (this.processingMessages.size > 0) {
            logger.warn(`Forced shutdown with ${this.processingMessages.size} messages still processing`);
        }

        this.clear();
        logger.info('Deduplication service shutdown complete');
    }
}

module.exports = DeduplicationService; 