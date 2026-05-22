-- =====================================================================
-- iFood — Pagamentos por Pedido
-- Migration 002
--
-- Extrai os meios de pagamento de cada pedido a partir do
-- payload da API Sales (ifood_fin_raw). Permite listar
-- pedido a pedido com o(s) meio(s) usado(s).
-- =====================================================================

CREATE TABLE IF NOT EXISTS ifood_pedido_pagamentos (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    merchant_id     VARCHAR(64)  NOT NULL,
    order_id        VARCHAR(64)  NOT NULL,
    order_short_id  VARCHAR(20)  NULL,

    -- dados do pagamento (array payments[] da API Sales)
    metodo          VARCHAR(40)  NULL  COMMENT 'CREDIT, DEBIT, CASH, PIX, MEAL_VOUCHER...',
    bandeira        VARCHAR(40)  NULL  COMMENT 'VISA, MASTERCARD, ELO...',
    valor           DECIMAL(14,2) NOT NULL DEFAULT 0,
    troco           DECIMAL(14,2) NULL,
    parcelas        SMALLINT     NULL,

    -- dados da venda (header)
    data_pedido     DATETIME     NULL,
    status_venda    VARCHAR(40)  NULL,
    valor_bruto     DECIMAL(14,2) NULL,

    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    KEY idx_order    (order_id),
    KEY idx_merchant (merchant_id),
    KEY idx_data     (data_pedido)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
