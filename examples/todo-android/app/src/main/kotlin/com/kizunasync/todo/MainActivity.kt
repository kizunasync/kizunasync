package com.kizunasync.todo

import android.content.Context
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kizunasync.kizunasync.KizunaSyncClient
import com.kizunasync.kizunasync.KizunaSyncConnectivityPathMonitor
import com.kizunasync.kizunasync.KizunaSyncForegroundSource
import com.kizunasync.kizunasync.KizunaSyncOp
import com.kizunasync.kizunasync.KizunaSyncOverwrite
import com.kizunasync.kizunasync.KizunaSyncPathMonitor
import com.kizunasync.kizunasync.KizunaSyncProcessForegroundSource
import com.kizunasync.kizunasync.KizunaSyncRejection
import com.kizunasync.kizunasync.KizunaSyncScheduler
import java.util.UUID
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONArray

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { TodoApp() }
    }
}

class TodoViewModel : ViewModel() {
    var titles by mutableStateOf(listOf<String>())
        private set
    var draft by mutableStateOf("")
    var depth by mutableIntStateOf(0)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var needsReset by mutableStateOf(false)
        private set

    /**
     * Why sync is blocked, from the checkpoint: `identity_changed` when the
     * local data belongs to another user than the token's, otherwise a server
     * refusal.
     */
    var softBlockReason by mutableStateOf<String?>(null)
        private set

    var rejections by mutableStateOf(listOf<KizunaSyncRejection>())
        private set
    var overwrites by mutableStateOf(listOf<KizunaSyncOverwrite>())
        private set
    private var liveSyncOn by mutableStateOf(true)

    /** Off stops the automatic sync loop; on starts it again, which syncs once right away. */
    var liveSync: Boolean
        get() = liveSyncOn
        set(value) {
            liveSyncOn = value
            if (value) {
                scheduler?.start()
            } else {
                scheduler?.stop()
            }
        }

    var tab by mutableIntStateOf(0)
    var supabaseUrl by mutableStateOf(System.getenv("SUPABASE_URL").orEmpty())
    var publishableKey by mutableStateOf(
        System.getenv("SUPABASE_PUBLISHABLE_KEY").orEmpty().ifEmpty {
            System.getenv("SUPABASE_ANON_KEY").orEmpty()
        },
    )
    var accessToken by mutableStateOf(System.getenv("SUPABASE_ACCESS_TOKEN").orEmpty())

    private var client: KizunaSyncClient? = null
    private var scheduler: KizunaSyncScheduler? = null
    private var pathMonitor: KizunaSyncPathMonitor? = null
    private var foregroundSource: KizunaSyncForegroundSource? = null
    private var deviceId: String? = null
    private lateinit var databasePath: String

    fun boot(context: Context) {
        databasePath = "${context.filesDir.absolutePath}/kizunasync-todos.sqlite"
        pathMonitor = KizunaSyncConnectivityPathMonitor(context.applicationContext)
        foregroundSource = KizunaSyncProcessForegroundSource()
        deviceId = resolveDeviceId(context)
        reconnect()
    }

    /**
     * The device identity the server's `_clients` registry keys on. It is a uuid
     * and it outlives a launch, so retention sees one device rather than one per
     * run.
     */
    private fun resolveDeviceId(context: Context): String {
        val store = context.applicationContext.getSharedPreferences("kizunasync", Context.MODE_PRIVATE)
        store.getString("clientId", null)?.let { return it }
        val minted = UUID.randomUUID().toString()
        store.edit().putString("clientId", minted).apply()
        return minted
    }

    /**
     * Disposes whatever client this replaces before opening the new one: both
     * would otherwise hold the same SQLite file at databasePath open at once.
     * setAccessToken runs only inside the scheduler's refreshSession, once
     * per reconnect, instead of once here and again on the first poll.
     */
    fun reconnect() {
        viewModelScope.launch {
            try {
                scheduler?.stop()
                client?.dispose()
                client = null
                val next = KizunaSyncClient()
                next.create(
                    TodoBoard.clientConfig(
                        clientId = deviceId,
                        databasePath = databasePath,
                        supabaseUrl = supabaseUrl.ifEmpty { null },
                        publishableKey = publishableKey.ifEmpty { null },
                        accessToken = accessToken.ifEmpty { null },
                    ),
                )
                client = next
                startScheduler(next)
                refresh()
            } catch (e: Exception) {
                error = e.message
            }
        }
    }

    /**
     * The scheduler's timer and path monitor must stop, and the engine's
     * SQLite file must close, when this ViewModel is destroyed. dispose() is
     * suspend, and viewModelScope is cancelled right after this method
     * returns, so it cannot race a launched coroutine to completion; blocking
     * here is the guaranteed-to-finish alternative.
     */
    override fun onCleared() {
        scheduler?.stop()
        runBlocking { client?.dispose() }
    }

    fun add() {
        val title = draft.trim()
        if (title.isEmpty()) {
            return
        }
        draft = ""
        viewModelScope.launch {
            try {
                client?.apply(
                    table = TodoBoard.TABLE,
                    pk = UUID.randomUUID().toString(),
                    op = KizunaSyncOp.Insert,
                    columns = mapOf("title" to title, "user_id" to "local-dev", "done" to false),
                    mutationId = UUID.randomUUID().toString(),
                )
                refresh()
            } catch (e: Exception) {
                error = e.message
            }
        }
    }

    private suspend fun refresh() {
        val engine = client ?: return
        depth = engine.outboxDepth()
        rejections = engine.rejections()
        overwrites = engine.overwrites()
        val checkpoint = engine.checkpoint()
        needsReset = checkpoint.softBlocked
        softBlockReason = checkpoint.softBlockReason
        val raw = engine.query(TodoBoard.TABLE)
        val rows = raw as? JSONArray ?: JSONArray()
        val next = mutableListOf<String>()
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i)
            val title =
                when {
                    row.has("title") -> row.optString("title")
                    row.has("columns") -> row.getJSONObject("columns").optString("title")
                    else -> ""
                }
            if (title.isNotEmpty()) {
                next.add(title)
            }
        }
        titles = next
    }

    /**
     * The way out of a soft block: drop the local database and rehydrate from
     * the server on the next pull. The sandbox paths the engine answers with are
     * the attachment bytes the app still has to delete; this shell declares no
     * attachment column, so the list is empty.
     */
    fun resetLocal() {
        viewModelScope.launch {
            try {
                client?.reset()
                needsReset = false
                softBlockReason = null
                client?.sync()
                refresh()
            } catch (e: Exception) {
                error = e.message
            }
        }
    }

    fun dismissOverwrite(entry: KizunaSyncOverwrite) {
        viewModelScope.launch {
            try {
                client?.dismissOverwrite(entry.id)
                refresh()
            } catch (e: Exception) {
                error = e.message
            }
        }
    }

    private fun startScheduler(client: KizunaSyncClient) {
        val hasRemote = supabaseUrl.isNotEmpty() && publishableKey.isNotEmpty()
        scheduler =
            KizunaSyncScheduler(
                client = client,
                refreshSession = {
                    if (hasRemote && accessToken.isEmpty()) {
                        false
                    } else {
                        if (accessToken.isNotEmpty()) {
                            client.setAccessToken(accessToken)
                        }
                        true
                    }
                },
                sync = {
                    client.sync()
                    refresh()
                },
                pathMonitor = pathMonitor,
                onError = { failure -> error = failure.message },
                foregroundSource = foregroundSource,
                needsResetSource = { client.checkpoint().softBlocked },
            )
        scheduler?.onHealth { health ->
            needsReset = health.needsReset
            if (health.needsReset) {
                viewModelScope.launch {
                    softBlockReason = runCatching { client.checkpoint().softBlockReason }.getOrNull()
                }
            } else {
                softBlockReason = null
            }
        }
        if (liveSync) {
            scheduler?.start()
        }
    }
}

@Composable
fun TodoApp(model: TodoViewModel = viewModel()) {
    val context = LocalContext.current
    LaunchedEffect(Unit) {
        model.boot(context)
    }
    MaterialTheme {
        Scaffold(
            bottomBar = {
                NavigationBar {
                    NavigationBarItem(
                        selected = model.tab == 0,
                        onClick = { model.tab = 0 },
                        icon = { Icon(Icons.AutoMirrored.Filled.List, contentDescription = "Board") },
                        label = { Text("Board") },
                    )
                    NavigationBarItem(
                        selected = model.tab == 1,
                        onClick = { model.tab = 1 },
                        icon = { Icon(Icons.Filled.Info, contentDescription = "Cache") },
                        label = { Text("Cache") },
                    )
                    NavigationBarItem(
                        selected = model.tab == 2,
                        onClick = { model.tab = 2 },
                        icon = { Icon(Icons.Filled.Settings, contentDescription = "Settings") },
                        label = { Text("Settings") },
                    )
                }
            },
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
                when (model.tab) {
                    0 -> BoardPane(model)
                    1 -> CachePane(model)
                    else -> SettingsPane(model)
                }
            }
        }
    }
}

@Composable
private fun BoardPane(model: TodoViewModel) {
    OutlinedTextField(
        value = model.draft,
        onValueChange = { model.draft = TodoBoard.clampedTitle(it) },
        label = { Text("New todo") },
    )
    Button(onClick = { model.add() }, modifier = Modifier.padding(top = 8.dp)) {
        Text("Add")
    }
    LazyColumn {
        items(model.titles) { title ->
            ListItem(headlineContent = { Text(title) })
        }
    }
}

@Composable
private fun CachePane(model: TodoViewModel) {
    Text("Outbox ${model.depth}")
    model.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    if (model.needsReset) {
        Text(
            if (model.softBlockReason == "identity_changed") {
                "The local data belongs to another user than the one signed in, so sync is blocked until reset() runs."
            } else {
                "The server refused this client, so sync is blocked until reset() runs."
            },
            color = MaterialTheme.colorScheme.error,
        )
        Button(onClick = { model.resetLocal() }, modifier = Modifier.padding(top = 8.dp)) {
            Text("Reset local database")
        }
    }
    Text("Rejections ${model.rejections.size}", modifier = Modifier.padding(top = 8.dp))
    LazyColumn {
        items(model.rejections) { rejection ->
            ListItem(
                headlineContent = { Text(rejection.table) },
                supportingContent = { Text(rejection.reason) },
            )
        }
    }
    Text("Overwrites ${model.overwrites.size}", modifier = Modifier.padding(top = 8.dp))
    LazyColumn {
        items(model.overwrites) { entry ->
            ListItem(
                headlineContent = { Text("${entry.table}.${entry.column}") },
                supportingContent = { Text(entry.conflictMode) },
                trailingContent = {
                    Button(onClick = { model.dismissOverwrite(entry) }) { Text("Dismiss") }
                },
            )
        }
    }
}

@Composable
private fun SettingsPane(model: TodoViewModel) {
    Text("Live sync")
    Switch(checked = model.liveSync, onCheckedChange = { model.liveSync = it })
    OutlinedTextField(
        value = model.supabaseUrl,
        onValueChange = { model.supabaseUrl = it },
        label = { Text("Supabase URL") },
        modifier = Modifier.padding(top = 8.dp),
    )
    OutlinedTextField(
        value = model.publishableKey,
        onValueChange = { model.publishableKey = it },
        label = { Text("Publishable key") },
        modifier = Modifier.padding(top = 8.dp),
    )
    OutlinedTextField(
        value = model.accessToken,
        onValueChange = { model.accessToken = it },
        label = { Text("Session JWT") },
        modifier = Modifier.padding(top = 8.dp),
    )
    Button(onClick = { model.reconnect() }, modifier = Modifier.padding(top = 8.dp)) {
        Text("Reconnect")
    }
}
