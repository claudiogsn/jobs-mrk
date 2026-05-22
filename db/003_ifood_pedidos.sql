-- =====================================================================
-- iFood — Pedidos
-- Migration 003
--
-- Registra todos os pedidos vindos da API Sales, independente de
-- Financial Events. Permite acompanhar pedido a pedido o status
-- do repasse (aguardando / agendado / pago) e a semana (competência)
-- a que cada pedido pertence.
-- =====================================================================

CREATE TABLE IF NOT EXISTS ifood_pedidos (
    id                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
    merchant_id         VARCHAR(64)      NOT NULL,
    credencial_id       BIGINT UNSIGNED  NULL,
    competencia_id      BIGINT UNSIGNED  NULL,

    order_id            VARCHAR(64)      NOT NULL,
    order_short_id      VARCHAR(20)      NULL,

    -- dados do pedido
    status              VARCHAR(40)      NULL  COMMENT 'CONCLUDED, CANCELLED, PLACED...',
    tipo                VARCHAR(40)      NULL  COMMENT 'ORDER',
    categoria           VARCHAR(40)      NULL  COMMENT 'FOOD',
    canal               VARCHAR(40)      NULL  COMMENT 'IFOOD',
    tipo_entrega        VARCHAR(40)      NULL  COMMENT 'DELIVERY, TAKEOUT, INDOOR',
    provedor_logistica  VARCHAR(40)      NULL  COMMENT 'MERCHANT, IFOOD',

    data_pedido         DATETIME         NULL,

    -- valores (de saleGrossValue + billingSummary)
    valor_bag           DECIMAL(14,2)    NULL  COMMENT 'saleGrossValue.bag',
    valor_entrega       DECIMAL(14,2)    NULL  COMMENT 'saleGrossValue.deliveryFee',
    valor_servico       DECIMAL(14,2)    NULL  COMMENT 'saleGrossValue.serviceFee',
    valor_bruto         DECIMAL(14,2)    NULL  COMMENT 'bag + deliveryFee + serviceFee',
    valor_beneficios    DECIMAL(14,2)    NULL  COMMENT 'benefits.totalValue (desconto iFood)',
    valor_liquido       DECIMAL(14,2)    NULL  COMMENT 'billingSummary.saleBalance',

    -- acompanhamento do repasse
    status_repasse      ENUM('AGUARDANDO','AGENDADO','PAGO') NOT NULL DEFAULT 'AGUARDANDO'
                        COMMENT 'AGUARDANDO=sem settlement | AGENDADO=scheduled | PAGO=compensated',

    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_order        (merchant_id, order_id),
    KEY idx_competencia        (competencia_id),
    KEY idx_data               (data_pedido),
    KEY idx_status             (status),
    KEY idx_repasse            (status_repasse),
    KEY idx_merchant           (merchant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
