package com.kizunasync.kizunasync

import java.util.concurrent.CopyOnWriteArrayList
import java.util.logging.Handler
import java.util.logging.LogRecord
import java.util.logging.Logger

/** The records the client's logger published while a [capturingClientLog] block ran. */
class KizunaSyncLogCapture : Handler() {
    val records = CopyOnWriteArrayList<LogRecord>()

    override fun publish(record: LogRecord) {
        records.add(record)
    }

    override fun flush() {}

    override fun close() {}
}

/**
 * Runs [block] with a capture on the `com.kizunasync.kizunasync` logger. The
 * parent handlers stay off meanwhile, so an expected warning stays out of the
 * test run's console.
 */
inline fun <T> capturingClientLog(block: (KizunaSyncLogCapture) -> T): T {
    val logger = Logger.getLogger("com.kizunasync.kizunasync")
    val capture = KizunaSyncLogCapture()
    val parentHandlers = logger.useParentHandlers
    logger.addHandler(capture)
    logger.useParentHandlers = false
    try {
        return block(capture)
    } finally {
        logger.removeHandler(capture)
        logger.useParentHandlers = parentHandlers
    }
}
