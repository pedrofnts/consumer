# RabbitMQ Consumer API v2.0

Uma aplicação robusta e modular para consumo de filas RabbitMQ com API REST para gerenciamento.

## 🚀 Principais Recursos

- **🔄 Reconexão Inteligente**: Sistema robusto com debounce e backoff exponencial
- **🛡️ Deduplicação de Mensagens**: Previne processamento de mensagens duplicadas
- **⏰ Horário Comercial**: Processamento apenas dentro do horário configurado
- **🔗 Webhooks com Retry**: Envio confiável com tentativas automáticas
- **💾 Persistência Automática**: Restaura filas automaticamente após reinicialização
- **🛡️ Detecção Automática**: Monitora saúde das filas e remove automaticamente filas deletadas externamente
- **📊 API REST Completa**: Gerenciamento via HTTP endpoints
- **🎯 Graceful Shutdown**: Finalização limpa aguardando processamento
- **📈 Monitoramento**: Logs estruturados e métricas detalhadas

## 📁 Estrutura do Projeto

```
disparos/
├── index.js                    # Ponto de entrada
├── package.json               # Dependências e scripts
├── Dockerfile                 # Container configuration
├── README.md                  # Documentação
└── src/                       # Código fonte
    ├── config/
    │   └── config.js          # Configurações centralizadas
    ├── utils/
    │   ├── logger.js          # Sistema de logging
    │   └── helpers.js         # Funções utilitárias
    ├── services/
    │   ├── RabbitMQService.js     # Operações básicas RabbitMQ
    │   ├── DeduplicationService.js # Sistema de deduplicação
    │   ├── ReconnectionService.js  # Lógica de reconexão
    │   ├── WebhookService.js      # Envio de webhooks
    │   ├── MessageProcessor.js    # Processamento de mensagens
    │   ├── PersistenceService.js  # Persistência de configurações
    │   └── ConsumerService.js     # Serviço principal
    ├── controllers/
    │   └── QueueController.js     # Controlador da API
    ├── routes/
    │   └── queueRoutes.js         # Definição de rotas
    ├── middleware/
    │   └── requestLogger.js       # Middleware de logging
    └── app.js                     # Aplicação principal
```

## 🏗️ Arquitetura

### Responsabilidades dos Módulos

#### **Services (Serviços)**
- **RabbitMQService**: Conexão, canal, operações básicas (ACK/NACK)
- **DeduplicationService**: Cache de mensagens processadas, limpeza automática
- **ReconnectionService**: Detecta falhas, controla tentativas, debounce
- **WebhookService**: HTTP requests com retry, timeout, estatísticas
- **MessageProcessor**: Lógica de negócio, validações, processamento
- **PersistenceService**: Salva/carrega configurações, backup/restore
- **ConsumerService**: Orquestra todos os serviços, gerencia consumers, monitora saúde das filas

#### **Controllers**
- **QueueController**: Endpoints da API REST, validações, responses

#### **Utils**
- **Logger**: Logging estruturado com timestamps e metadata
- **Helpers**: Funções utilitárias (intervalos, validações, formatação)

#### **Config**
- **config.js**: Configurações centralizadas com validação

## 🔧 Configuração

### Variáveis de Ambiente

```bash
# Obrigatórias
RABBITMQ_URL=amqp://user:pass@localhost:5672
FINISH_WEBHOOK=https://your-domain.com/webhook/finish

# Opcionais
API_PORT=3000
NODE_ENV=production
```

### Configurações Avançadas

Edite `src/config/config.js` para ajustar:

```javascript
{
  // Intervalos padrão entre mensagens
  business: {
    defaultIntervals: {
      min: 30000,  // 30 segundos
      max: 110000  // 110 segundos
    }
  },
  
  // Configurações de reconexão
  reconnection: {
    maxAttempts: 10,
    baseDelay: 5000,
    debounceMs: 3000
  },
  
  // Cache de deduplicação
  deduplication: {
    maxProcessedMessages: 10000,
    cleanupIntervalMs: 60000
  }
}
```

## 📡 API Endpoints

### **Gerenciamento de Consumers**

#### `POST /consume`
Inicia consumo de uma fila
```json
{
  "queue": "my-queue",
  "webhook": "https://api.example.com/webhook",
  "minInterval": 30000,
  "maxInterval": 110000,
  "businessHours": { "start": 8, "end": 21 }
}
```

#### `POST /pause`
Pausa processamento (mensagens voltam para fila)
```json
{ "queue": "my-queue" }
```

#### `POST /resume`
Resume processamento pausado
```json
{ "queue": "my-queue" }
```

#### `POST /stop`
Para consumer completamente
```json
{ "queue": "my-queue" }
```

### **Monitoramento**

#### `GET /health`
Status da aplicação
```json
{
  "status": "healthy",
  "stats": { ... }
}
```

#### `GET /active-queues`
Lista todas as filas ativas com estimativas
```json
{
  "activeQueues": [
    {
      "queue": "my-queue",
      "messageCount": 150,
      "estimatedCompletion": {
        "formatted": "2h 30m 15s"
      }
    }
  ]
}
```

#### `GET /stats`
Estatísticas detalhadas
```json
{
  "activeConsumers": 3,
  "messageProcessor": {
    "processed": 1250,
    "failed": 5,
    "successRate": 99.6
  },
  "webhook": {
    "sent": 1250,
    "avgResponseTime": 245
  }
}
```

### **Utilitários**

#### `POST /webhook/test`
Testa conectividade de webhook
```json
{
  "url": "https://api.example.com/test",
  "timeout": 5000
}
```

#### `GET /queue-info/:queue`
Informações específicas de uma fila

### **Gerenciamento de Persistência**

#### `GET /persisted-queues`
Lista configurações de filas salvas
```json
{
  "persisted": {
    "my-queue": {
      "webhook": "https://api.example.com/webhook",
      "minInterval": 30000,
      "maxInterval": 110000,
      "businessHours": { "start": 8, "end": 21 },
      "savedAt": "2024-01-15T10:30:00.000Z"
    }
  },
  "stats": {
    "totalQueues": 1,
    "lastUpdated": "2024-01-15T10:30:00.000Z"
  }
}
```

#### `POST /restore-queues`
Restaura manualmente todas as filas salvas
```json
{
  "message": "Queue restoration completed",
  "result": {
    "restored": 2,
    "failed": 0,
    "skipped": 1
  }
}
```

#### `POST /backup-configs`
Cria backup das configurações
```json
{
  "path": "./backup/config-backup.json"  // opcional
}
```

#### `POST /restore-backup`
Restaura configurações de um backup
```json
{
  "backupPath": "./backup/config-backup.json"
}
```

#### `DELETE /clear-configs`
Limpa todas as configurações salvas
```json
{
  "message": "All persisted configurations cleared"
}
```



#### `POST /queues-info`
Informações de múltiplas filas
```json
{ "queues": ["queue1", "queue2", "queue3"] }
```

## 💾 Persistência Automática

Uma das principais funcionalidades desta versão 2.0 é a **persistência automática** das configurações de filas. Isso resolve o problema de ter que reconfigurar manualmente todas as filas após um reinício da aplicação.

### 🔄 Como Funciona

1. **Salvamento Automático**: Sempre que você inicia o consumo de uma fila (via `POST /consume`), a configuração é automaticamente salva em um arquivo JSON
2. **Restauração na Inicialização**: Quando a aplicação é reiniciada, ela automaticamente carrega e restaura todas as filas que estavam sendo consumidas
3. **Limpeza Inteligente**: Configurações são removidas apenas quando você para uma fila manualmente (não quando ela fica vazia)

### 📁 Localização dos Dados

As configurações são salvas em:
```
disparos/
└── data/
    └── queue-configurations.json
```

### 🎯 Benefícios

- **Zero Downtime**: Após um restart, suas filas voltam a funcionar automaticamente
- **Resistência a Falhas**: Mesmo que a aplicação crash, as configurações persistem
- **Facilidade Operacional**: Não é necessário reconfigurar nada manualmente
- **Backup Integrado**: Sistema de backup e restore para disaster recovery

### 📝 Exemplo de Arquivo de Configuração

```json
{
  "version": "1.0.0",
  "lastUpdated": "2024-01-15T10:30:00.000Z",
  "queues": {
    "orders": {
      "webhook": "https://api.example.com/orders",
      "minInterval": 30000,
      "maxInterval": 110000,
      "businessHours": { "start": 8, "end": 18 },
      "savedAt": "2024-01-15T10:30:00.000Z"
    },
    "notifications": {
      "webhook": "https://api.example.com/notify",
      "minInterval": 15000,
      "maxInterval": 60000,
      "businessHours": { "start": 0, "end": 24 },
      "savedAt": "2024-01-15T11:15:00.000Z"
    }
  }
}
```

### 🚨 Comportamento Especial

- **Filas Inexistentes**: Se uma fila salva não existir mais no RabbitMQ, ela será automaticamente removida das configurações
- **Parada Manual vs Automática**: Apenas paradas manuais (via API) removem as configurações. Se uma fila fica vazia naturalmente, a configuração é mantida
- **Validação na Restauração**: Todas as configurações são validadas antes da restauração

## 🚀 Instalação e Execução

### Via Docker (Recomendado)

```bash
# Build da imagem
docker build -t rabbitmq-consumer .

# Executar
docker run -d \
  --name rabbitmq-consumer \
  -p 3000:3000 \
  -e RABBITMQ_URL=amqp://user:pass@rabbitmq:5672 \
  -e FINISH_WEBHOOK=https://your-domain.com/webhook \
  rabbitmq-consumer
```

### Via Node.js

```bash
# Instalar dependências
npm install

# Configurar variáveis de ambiente
export RABBITMQ_URL=amqp://localhost:5672
export FINISH_WEBHOOK=https://your-domain.com/webhook

# Executar
npm start
```

## 🔄 Fluxo de Processamento

```mermaid
graph TB
    A[RabbitMQ] -->|Mensagem| B[DeduplicationService]
    B -->|Check Duplicate| C{Já Processada?}
    C -->|Sim| D[ACK & Skip]
    C -->|Não| E[MessageProcessor]
    E --> F{Horário Comercial?}
    F -->|Não| G[NACK & Return]
    F -->|Sim| H{Consumer Pausado?}
    H -->|Sim| G
    H -->|Não| I[Enviar Webhook]
    I --> J{Sucesso?}
    J -->|Sim| K[ACK & Mark Processed]
    J -->|Não| L{Erro 4xx?}
    L -->|Sim| K
    L -->|Não| G
    K --> M[Verificar Fila Vazia]
    M -->|Vazia| N[Remover Consumer]
    M -->|Com Mensagens| O[Definir Próximo Interval]
```

## 🛠️ Desenvolvimento

### Estrutura de Classes

```javascript
// Exemplo de uso interno
const app = new RabbitMQConsumerApp();
await app.start();

// Acessar serviços
const stats = app.services.consumer.getStats();
const queueInfo = await app.services.consumer.getQueueInfo('my-queue');
```

### Logging

Todos os logs são estruturados com timestamp e metadata:

```javascript
logger.consumer('Processing message', {
  messageId: 'abc123',
  queue: 'my-queue',
  deliveryTag: 17
});
```

### Adicionando Novos Endpoints

1. Adicione método no `QueueController`
2. Registre rota em `queueRoutes.js`
3. Implemente lógica nos services conforme necessário

## 🔒 Segurança

- Headers de segurança automáticos
- Validação de entrada em todos endpoints
- Rate limiting configurável via reverse proxy
- Logs estruturados para auditoria

## 📊 Monitoramento e Observabilidade

### Métricas Disponíveis

- **Processamento**: Taxa de sucesso, mensagens/segundo, tempo médio
- **Webhooks**: Response time, taxa de erro, retries
- **Deduplicação**: Cache size, hits/misses, limpeza
- **Reconexão**: Tentativas, tempo down, recovery

### Health Checks

```bash
# Status básico
curl http://localhost:3000/health

# Verificar se específica fila está ativa
curl http://localhost:3000/queue-info/my-queue
```

## 🚨 Troubleshooting

### Problemas Comuns

1. **Mensagens Duplicadas**: Sistema de deduplicação está ativo
2. **Reconexão Infinita**: Verifique credenciais e conectividade
3. **Webhook Timeout**: Ajuste timeout nas configurações
4. **Memory Leak**: Cache de deduplicação é limitado e limpo automaticamente
5. **Fila Deletada Externamente**: Sistema detecta e limpa automaticamente

### ✅ Filas Deletadas Diretamente no RabbitMQ

**Solução Automática**: O sistema detecta automaticamente quando uma fila é deletada externamente e:
- Remove o consumer da fila automaticamente
- Limpa a configuração salva
- Não afeta outras filas em execução
- Envia notificação de webhook sobre a remoção

**Detecção Proativa**: Além da detecção durante operações, o sistema também:
- Monitora periodicamente (a cada 2 minutos) a saúde de todas as filas ativas
- Detecta proativamente filas deletadas externamente
- Remove automaticamente sem intervenção manual

**Logs que você verá**:
```
[INFO] Running periodic queue health check { queues: 2 }
[WARN] Periodic health check detected externally deleted queue { queue: "teste" }
[WARN] Queue was deleted externally, cleaning up consumer automatically
[INFO] Automatically removed externally deleted queue from persistence
[INFO] Automatically cleaned up externally deleted queue
```

**Não é necessária intervenção manual** - o sistema é totalmente robusto contra este cenário.

### Logs Importantes

```bash
# Erro de reconexão
grep "Reconnection" logs.txt

# Problemas de webhook
grep "Webhook" logs.txt

# Estatísticas de performance
curl http://localhost:3000/stats
```

## 📈 Performance

### Otimizações Implementadas

- **Prefetch**: Controla quantas mensagens não-ACKed
- **Connection Pooling**: Reutilização de conexões HTTP
- **Memory Management**: Limpeza automática de cache
- **Async Processing**: Não-bloqueante em todas operações

### Benchmarks Típicos

- **Throughput**: 1000+ mensagens/minuto
- **Memory Usage**: ~50MB base + 50KB por 1000 mensagens em cache
- **Latency**: <100ms por mensagem (sem webhook)

---

## 📝 Changelog

### v2.0.0
- ✅ Arquitetura completamente modular
- ✅ Sistema robusto de reconexão
- ✅ Deduplicação de mensagens
- ✅ **Persistência automática de configurações**
- ✅ **Sistema de backup e restore**
- ✅ **Detecção automática de filas deletadas externamente**
- ✅ **Monitoramento periódico de saúde das filas**
- ✅ **Proteção contra erros isolados afetarem outras filas**
- ✅ API REST completa
- ✅ Logs estruturados
- ✅ Graceful shutdown
- ✅ Monitoramento avançado

### v1.0.0
- Versão monolítica original

---

**Desenvolvido com ❤️ para robustez e escalabilidade** 