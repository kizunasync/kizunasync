package com.kizunasync.todo

import com.kizunasync.kizunasync.KizunaSyncClientConfig
import com.kizunasync.kizunasync.KizunaSyncRemoteConfig
import com.kizunasync.kizunasync.KizunaSyncTableConfig

object TodoBoard {
    const val TABLE = "todos"
    const val TITLE_MAX_LENGTH = 50

    /** Caps [title] at [TITLE_MAX_LENGTH] characters, matching the server's check constraint. */
    fun clampedTitle(title: String): String = if (title.length > TITLE_MAX_LENGTH) title.take(TITLE_MAX_LENGTH) else title

    /**
     * [clientId] is the device identity the server registers, so it is a uuid;
     * passing null mints one for this run.
     */
    fun clientConfig(
        clientId: String? = null,
        databasePath: String,
        supabaseUrl: String? = null,
        publishableKey: String? = null,
        accessToken: String? = null,
    ): KizunaSyncClientConfig {
        val remote =
            if (!supabaseUrl.isNullOrEmpty() && !publishableKey.isNullOrEmpty()) {
                KizunaSyncRemoteConfig(
                    url = supabaseUrl,
                    publishableKey = publishableKey,
                    accessToken = accessToken,
                )
            } else {
                null
            }
        return KizunaSyncClientConfig(
            clientId = clientId,
            tables = mapOf(TABLE to KizunaSyncTableConfig()),
            databasePath = databasePath,
            remote = remote,
        )
    }
}
