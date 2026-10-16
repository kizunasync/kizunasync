package com.kizunasync.expo

import io.github.expo.modules.v2.Event
import io.github.expo.modules.v2.ExpoModule
import io.github.expo.modules.v2.JS
import io.github.expo.modules.v2.Module
import io.github.expo.modules.v2.react.androidContext
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import uniffi.kizunasync_ffi.EventObserver
import uniffi.kizunasync_ffi.FfiEngineEvent
import uniffi.kizunasync_ffi.KizunaSyncEngine

/** Modules API 2.0 owns engine lifetimes; all storage remains in Rust/Turso. */
@ExpoModule(name = "KizunaSyncExpo")
class KizunaSyncExpoModule : Module() {
  @Event(name = "engineEvent")
  val onEngineEvent = event<String>()

  private data class Session(val engine: KizunaSyncEngine, val observer: EventObserver, val subscription: ULong) {
    fun close() {
      try {
        try { engine.unsubscribe(subscription) } finally { engine.shutdown() }
      } finally { engine.destroy() }
    }
  }

  private val sessions = ConcurrentHashMap<String, Session>()
  private val lifecycle = Any()
  private var destroyed = false

  @JS
  fun newEngineId(): String = UUID.randomUUID().toString()

  @JS
  fun databasePath(name: String): String {
    if (name == ":memory:") return name
    require(name.isNotEmpty() && File(name).name == name && name != "." && name != "..") { "Invalid database name" }
    // Match expo-sqlite's existing default directory, without opening SQLite.
    val directory = File(androidContext.filesDir, "SQLite")
    check(directory.isDirectory || directory.mkdirs()) { "Cannot create the database directory" }
    return File(directory, name).absolutePath
  }

  @JS
  suspend fun createEngine(id: String, configJson: String) = withContext(Dispatchers.IO) {
    val engine = KizunaSyncEngine()
    var session: Session? = null
    try {
      engine.create(configJson)
      val identity = JSONObject(engine.call("store_kind", "{}"))
      check(identity.optJSONObject("value")?.optString("engine") == "turso") {
        "Rebuild the Kizuna native engine with Turso; this binary predates the migration"
      }
      val observer = object : EventObserver {
        override fun onEvent(event: FfiEngineEvent) {
          val payload = JSONObject().put("id", id).put("event", encode(event)).toString()
          // Teardown may race a final native event; never throw across UniFFI.
          runCatching { onEngineEvent.emit(payload) }
        }
      }
      val created = Session(engine, observer, engine.subscribe(observer))
      session = created
      synchronized(lifecycle) {
        check(!destroyed) { "Expo module was destroyed during engine creation" }
        check(sessions.putIfAbsent(id, created) == null) { "Engine id already exists" }
      }
    } catch (error: Throwable) {
      runCatching {
        if (session != null) session.close()
        else { try { engine.shutdown() } finally { engine.destroy() } }
      }
      throw error
    }
  }

  private fun engine(id: String): KizunaSyncEngine = checkNotNull(sessions[id]) { "Engine is closed" }.engine

  @JS
  fun call(id: String, method: String, paramsJson: String): String = engine(id).call(method, paramsJson)

  @JS
  suspend fun callAsync(id: String, method: String, paramsJson: String): String =
    engine(id).callAsync(method, paramsJson)

  @JS
  suspend fun closeEngine(id: String) = withContext(Dispatchers.IO) {
    val closing = synchronized(lifecycle) { sessions.remove(id) }
    closing?.close()
    Unit
  }

  override fun onDestroy() {
    val closing = synchronized(lifecycle) {
      destroyed = true
      sessions.values.toList().also { sessions.clear() }
    }
    closing.forEach { runCatching { it.close() } }
    super.onDestroy()
  }

  private fun encode(event: FfiEngineEvent): JSONObject {
    val inner = JSONObject()
    val tag = when (event) {
      is FfiEngineEvent.LocalChanged -> "LocalChanged"
      is FfiEngineEvent.CheckpointExpired -> "CheckpointExpired"
      is FfiEngineEvent.MutationRejected -> { inner.put("mutationId", event.mutationId).put("reason", event.reason); "MutationRejected" }
      is FfiEngineEvent.QueueDepth -> { inner.put("depth", event.depth.toLong()); "QueueDepth" }
      is FfiEngineEvent.ResetRequired -> { event.reason?.let { inner.put("reason", it) }; "ResetRequired" }
      is FfiEngineEvent.BatchAborted -> { inner.put("offenderMutationId", event.offenderMutationId).put("reason", event.reason); "BatchAborted" }
      is FfiEngineEvent.DeadLetter -> { inner.put("mutationId", event.mutationId).put("reason", event.reason); "DeadLetter" }
      is FfiEngineEvent.ColumnOverwritten -> {
        inner.put("table", event.table).put("pk", event.pk).put("column", event.column)
          .put("loserValueJson", event.loserValueJson).put("winnerMutationId", event.winnerMutationId).put("conflictMode", event.conflictMode)
        "ColumnOverwritten"
      }
    }
    return JSONObject().put("tag", tag).put("inner", inner)
  }
}
