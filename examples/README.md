# Exemplos de Uso - RabbitMQ Consumer API v2.0

Este diretório contém exemplos práticos de como usar as funcionalidades da API.

## 📁 Arquivos

### `persistence-example.js`

Demonstra as funcionalidades de persistência automática:

- Verificação de configurações salvas
- Início de consumo de filas (salvamento automático)
- Criação de backups
- Parada manual vs automática
- Restauração manual de configurações



## 🚀 Como Executar

### Pré-requisitos

1. A aplicação deve estar rodando:
```bash
npm start
# ou
docker run -p 3000:3000 rabbitmq-consumer
```

2. RabbitMQ deve estar acessível com as filas `orders` e `notifications` criadas

3. Instalar axios se ainda não estiver instalado:
```bash
npm install axios
```

### Executar o Exemplo

```bash
node examples/persistence-example.js
```

### Saída Esperada

```
🚀 Exemplo de Persistência Automática - RabbitMQ Consumer API v2.0

🔄 Verificando status da aplicação...
Status: healthy

🔄 Verificando configurações salvas...
Filas salvas: 0

🔄 Iniciando consumo de filas (serão salvas automaticamente)...
✅ Fila "orders" iniciada e salva automaticamente
✅ Fila "notifications" iniciada e salva automaticamente

🔄 Verificando filas ativas...
Filas ativas: 2

🔄 Verificando configurações salvas após iniciar consumo...
Filas salvas: 2
Configurações salvas: [ 'orders', 'notifications' ]

🔄 Criando backup das configurações...
Backup criado: ./examples/backup-example.json

🔄 Parando uma fila manualmente (será removida da persistência)...
✅ Fila "notifications" parada manualmente

🔄 Verificando configurações após parada manual...
Filas salvas: 1
Configurações restantes: [ 'orders' ]

🔄 Restaurando manualmente as filas salvas...
Resultado da restauração: { restored: 1, failed: 0, skipped: 0 }

🔄 Estatísticas finais...
Consumers ativos: 1
Persistência habilitada: true

✅ Exemplo concluído com sucesso!

💡 Para testar a persistência automática:
   1. Reinicie a aplicação
   2. As filas salvas serão automaticamente restauradas
   3. Use GET /active-queues para verificar
```

## 🧪 Teste de Persistência Automática

Para ver a persistência automática em ação:

1. Execute o exemplo para criar algumas configurações
2. Pare a aplicação (`Ctrl+C`)
3. Reinicie a aplicação (`npm start`)
4. Verifique os logs de inicialização - você verá mensagens sobre restauração automática
5. Faça uma requisição para `GET /active-queues` - as filas estarão ativas novamente

## 📝 Personalizando o Exemplo

Você pode modificar o arquivo `persistence-example.js` para:

- Usar suas próprias URLs de webhook
- Testar com suas filas do RabbitMQ
- Ajustar intervalos e horários comerciais
- Experimentar com diferentes cenários

## 🔍 Comandos Úteis

```bash
# Verificar configurações salvas
curl http://localhost:3000/persisted-queues

# Verificar filas ativas
curl http://localhost:3000/active-queues

# Criar backup manual
curl -X POST http://localhost:3000/backup-configs \
  -H "Content-Type: application/json" \
  -d '{"path":"./my-backup.json"}'

# Restaurar filas manualmente
curl -X POST http://localhost:3000/restore-queues

# Limpar todas as configurações
curl -X DELETE http://localhost:3000/clear-configs
```

## ⚠️ Notas Importantes

- As filas devem existir no RabbitMQ antes de tentar consumi-las
- URLs de webhook devem ser acessíveis para evitar erros
- O diretório `data/` será criado automaticamente para armazenar configurações
- Backups são salvos no local especificado ou com timestamp automático
- **Sistema é robusto**: Se você deletar uma fila diretamente no RabbitMQ, o sistema detecta automaticamente e limpa sem afetar outras filas 