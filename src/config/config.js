// Carregar variáveis de ambiente do arquivo .env
require('dotenv').config();

const config = {
    // RabbitMQ Configuration
    rabbitmq: {
        url: process.env.RABBITMQ_URL,
        heartbeat: 60,
        connectionTimeout: 10000,
        prefetch: 1
    },

    // API Configuration
    api: {
        port: process.env.API_PORT || 3000,
        timeout: 30000
    },

    // Webhook Configuration
    webhook: {
        finishUrl: process.env.FINISH_WEBHOOK,
        timeout: 10000,
        retryAttempts: 3,
        retryDelay: 1000,
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'RabbitMQ-Consumer/2.0'
        }
    },

    // Business Configuration
    business: {
        timezone: 'America/Sao_Paulo',
        defaultBusinessHours: {
            start: 8,
            end: 21
        },
        defaultIntervals: {
            min: 30000, // 30 seconds
            max: 110000 // 110 seconds
        }
    },

    // Reconnection Configuration
    reconnection: {
        maxAttempts: 10,
        baseDelay: 5000, // 5 seconds
        maxDelay: 60000, // 60 seconds
        debounceMs: 3000, // 3 seconds
        backoffMultiplier: 1.5
    },

    // Deduplication Configuration
    deduplication: {
        maxProcessedMessages: 10000,
        cleanupIntervalMs: 60000, // 1 minute
        messageIdTruncateLength: 20
    },

    // Graceful Shutdown Configuration
    shutdown: {
        maxWaitTimeMs: 30000, // 30 seconds
        checkIntervalMs: 1000 // 1 second
    }
};

// Validation functions
const validateConfig = () => {
    const errors = [];

    if (!config.rabbitmq.url) {
        errors.push('RABBITMQ_URL environment variable is required');
    }

    if (!config.rabbitmq.url || !config.rabbitmq.url.startsWith('amqp')) {
        errors.push('RABBITMQ_URL must be a valid AMQP URL');
    }

    if (config.api.port < 1 || config.api.port > 65535) {
        errors.push('API_PORT must be between 1 and 65535');
    }

    if (config.business.defaultBusinessHours.start >= config.business.defaultBusinessHours.end) {
        errors.push('Business hours start must be before end');
    }

    if (config.business.defaultIntervals.min >= config.business.defaultIntervals.max) {
        errors.push('Minimum interval must be less than maximum interval');
    }

    if (errors.length > 0) {
        throw new Error(`Configuration errors:\n${errors.join('\n')}`);
    }
};

// Initialize and validate configuration
try {
    validateConfig();
} catch (error) {
    console.error('Configuration validation failed:', error.message);
    process.exit(1);
}

module.exports = config; 