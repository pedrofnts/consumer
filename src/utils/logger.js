const { format } = require('date-fns-tz');
const config = require('../config/config');

class Logger {
    constructor() {
        this.timezone = config.business.timezone;
    }

    _getTimestamp() {
        return format(new Date(), 'yyyy-MM-dd HH:mm:ss.SSS', { 
            timeZone: this.timezone 
        });
    }

    _formatMessage(level, message, meta = {}) {
        const timestamp = this._getTimestamp();
        const metaStr = Object.keys(meta).length > 0 ? ` | ${JSON.stringify(meta)}` : '';
        return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
    }

    info(message, meta = {}) {
        console.log(this._formatMessage('info', message, meta));
    }

    warn(message, meta = {}) {
        console.warn(this._formatMessage('warn', message, meta));
    }

    error(message, error = null, meta = {}) {
        const errorMeta = error ? { 
            ...meta, 
            error: error.message, 
            stack: error.stack?.split('\n').slice(0, 3).join(' | ')
        } : meta;
        console.error(this._formatMessage('error', message, errorMeta));
    }

    debug(message, meta = {}) {
        if (process.env.NODE_ENV === 'development') {
            console.debug(this._formatMessage('debug', message, meta));
        }
    }

    // Specific logging methods for different components
    rabbitmq(message, meta = {}) {
        this.info(`[RabbitMQ] ${message}`, meta);
    }

    webhook(message, meta = {}) {
        this.info(`[Webhook] ${message}`, meta);
    }

    consumer(message, meta = {}) {
        this.info(`[Consumer] ${message}`, meta);
    }

    api(message, meta = {}) {
        this.info(`[API] ${message}`, meta);
    }

    reconnection(message, meta = {}) {
        this.warn(`[Reconnection] ${message}`, meta);
    }
}

module.exports = new Logger(); 