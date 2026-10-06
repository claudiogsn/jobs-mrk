# Testes de faturamento

```sh
npm run test:faturamento
```

Os testes usam mocks de API, RabbitMQ e WhatsApp. Não enviam mensagens nem alteram o banco operacional.

Cobrem a montagem das mensagens diária/semanal, valores numéricos recebidos como texto, estatísticas pendentes, erro de endpoint distinto de faturamento zero, envio do ID interno da unidade, consultas Zig estritas, preservação de dados importados em caso de falha, pagamentos incompletos e datas inválidas.

Publicar a correção correspondente do `portal-mrk` primeiro. Os endpoints `generateResumoFinanceiroPorLoja` e `ZigUpdateStatics` aceitam o novo argumento opcional `system_unit_id`; clientes antigos continuam compatíveis.
