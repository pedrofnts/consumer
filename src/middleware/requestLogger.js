const logger = require('../utils/logger');

/**
 * Middleware de logging de requisições
 */
function requestLogger(req, res, next) {
    const start = Date.now();
    
    // Log da requisição inicial
    logger.api('Request received', {
        method: req.method,
        path: req.path,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        contentLength: req.get('Content-Length') || 0
    });

    // Interceptar o final da resposta
    const originalSend = res.send;
    res.send = function(data) {
        const duration = Date.now() - start;
        
        logger.api('Request completed', {
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            duration: `${duration}ms`,
            contentLength: data ? data.length : 0
        });

        originalSend.call(this, data);
    };

    next();
}

module.exports = requestLogger; 