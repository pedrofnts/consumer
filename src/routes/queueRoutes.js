const express = require('express');
const router = express.Router();

/**
 * Configura todas as rotas relacionadas a filas
 */
function setupQueueRoutes(queueController) {
    // Health check
    router.get('/health', (req, res) => queueController.getHealth(req, res));

    // Consumer management
    router.post('/consume', (req, res) => queueController.startConsuming(req, res));
    router.post('/pause', (req, res) => queueController.pauseConsuming(req, res));
    router.post('/resume', (req, res) => queueController.resumeConsuming(req, res));
    router.post('/stop', (req, res) => queueController.stopConsuming(req, res));

    // Queue information
    router.get('/active-queues', (req, res) => queueController.getActiveQueues(req, res));
    router.get('/queue-info/:queue', (req, res) => queueController.getQueueInfo(req, res));
    router.post('/queues-info', (req, res) => queueController.getQueuesInfo(req, res));

    // Statistics and monitoring
    router.get('/stats', (req, res) => queueController.getStats(req, res));
    router.post('/stats/reset', (req, res) => queueController.resetStats(req, res));

    // Webhook testing
    router.post('/webhook/test', (req, res) => queueController.testWebhook(req, res));

    // Persistence management
    router.get('/persisted-queues', (req, res) => queueController.getPersistedQueues(req, res));
    router.post('/restore-queues', (req, res) => queueController.restoreQueues(req, res));
    router.post('/backup-configs', (req, res) => queueController.createBackup(req, res));
    router.post('/restore-backup', (req, res) => queueController.restoreFromBackup(req, res));
    router.delete('/clear-configs', (req, res) => queueController.clearPersistedConfigs(req, res));
    router.post('/cleanup-orphans', (req, res) => queueController.cleanupOrphanedConfigs(req, res));
    router.delete('/persisted-queue/:queue', (req, res) => queueController.removePersistedQueue(req, res));

    return router;
}

module.exports = setupQueueRoutes; 