const { zonedTimeToUtc, utcToZonedTime, format } = require('date-fns-tz');
const config = require('../config/config');

class Helpers {
    /**
     * Gera um intervalo aleatório entre min e max
     */
    getRandomInterval(minInterval, maxInterval) {
        return Math.floor(Math.random() * (maxInterval - minInterval + 1) + minInterval);
    }

    /**
     * Verifica se está dentro do horário comercial
     */
    isWithinBusinessHours(businessHours = config.business.defaultBusinessHours) {
        const localTime = utcToZonedTime(new Date(), config.business.timezone);
        const hour = parseInt(format(localTime, 'H', { timeZone: config.business.timezone }));
        return hour >= businessHours.start && hour < businessHours.end;
    }

    /**
     * Gera ID único para mensagem
     */
    generateMessageId(msg) {
        if (!msg) return null;
        try {
            const content = msg.content.toString();
            const deliveryTag = msg.fields.deliveryTag;
            const contentHash = Buffer.from(content)
                .toString('base64')
                .slice(0, config.deduplication.messageIdTruncateLength);
            return `${deliveryTag}_${contentHash}`;
        } catch (error) {
            return `${msg.fields.deliveryTag}_${Date.now()}`;
        }
    }

    /**
     * Calcula delay com backoff exponencial
     */
    calculateBackoffDelay(attempt) {
        const baseDelay = config.reconnection.baseDelay;
        const multiplier = config.reconnection.backoffMultiplier;
        const maxDelay = config.reconnection.maxDelay;
        
        return Math.min(baseDelay * Math.pow(multiplier, attempt - 1), maxDelay);
    }

    /**
     * Formata tempo estimado para completion
     */
    formatEstimatedTime(timeMs) {
        const hours = Math.floor(timeMs / (1000 * 60 * 60));
        const minutes = Math.floor((timeMs % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeMs % (1000 * 60)) / 1000);

        return {
            rawEstimateMs: timeMs,
            formatted: `${hours}h ${minutes}m ${seconds}s`,
            hours,
            minutes,
            seconds
        };
    }

    /**
     * Valida se uma string é uma URL válida
     */
    isValidUrl(string) {
        try {
            new URL(string);
            return string.startsWith('http://') || string.startsWith('https://');
        } catch (_) {
            return false;
        }
    }

    /**
     * Valida nome da fila
     */
    isValidQueueName(queue) {
        return typeof queue === 'string' && queue.trim() !== '';
    }

    /**
     * Sanitiza parâmetros de entrada
     */
    sanitizeIntervals(minInterval, maxInterval) {
        const min = Math.max(1000, minInterval || config.business.defaultIntervals.min); // Min 1 second
        const max = Math.max(min + 1000, maxInterval || config.business.defaultIntervals.max);
        return { min, max };
    }

    /**
     * Cria promise com timeout
     */
    createTimeoutPromise(promise, timeoutMs, errorMessage = 'Operation timed out') {
        const timeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
        });

        return Promise.race([promise, timeout]);
    }

    /**
     * Sleep/delay utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Retry com backoff
     */
    async retryWithBackoff(fn, maxAttempts = 3, baseDelay = 1000) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                
                if (attempt === maxAttempts) {
                    break;
                }
                
                const delay = baseDelay * Math.pow(2, attempt - 1);
                await this.sleep(delay);
            }
        }
        
        throw lastError;
    }
}

module.exports = new Helpers(); 