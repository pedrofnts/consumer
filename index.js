#!/usr/bin/env node

/**
 * RabbitMQ Consumer Application - Entry Point
 * 
 * This is a robust, modular RabbitMQ consumer with:
 * - Intelligent reconnection with debounce and backoff
 * - Message deduplication to prevent duplicates
 * - Business hours support
 * - Webhook integration with retry
 * - REST API for management
 * - Graceful shutdown
 * - Comprehensive logging and monitoring
 */

const RabbitMQConsumerApp = require('./src/app');

// Criar e iniciar a aplicação
const app = new RabbitMQConsumerApp();

// Iniciar aplicação
app.start().catch((error) => {
    console.error('Failed to start application:', error.message);
    process.exit(1);
});