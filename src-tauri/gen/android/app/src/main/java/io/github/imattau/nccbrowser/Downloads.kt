package io.github.imattau.nccbrowser

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Recent downloads.
 *
 * Kept in the app's files directory rather than the shell's storage, because the
 * download itself happens here: the content view hands over a file, this process
 * fetches it and the system picker decides where it lands. A list that emptied on
 * restart would also lose the only record of where the file went.
 */
class Downloads(private val context: Context) {
  private val file = File(context.filesDir, "downloads.json")
  private val entries = mutableListOf<Entry>()

  /** Called on the thread that changed the list; the activity marshals to the shell. */
  var onChange: ((String) -> Unit)? = null

  data class Entry(
    val id: String,
    val name: String,
    val url: String,
    var state: String,
    var bytes: Long,
    val total: Long,
    val at: Long,
  )

  init {
    load()
  }

  @Synchronized
  fun json(): String {
    val array = JSONArray()
    for (entry in entries) {
      array.put(
        JSONObject()
          .put("id", entry.id)
          .put("name", entry.name)
          .put("url", entry.url)
          .put("state", entry.state)
          .put("bytes", entry.bytes)
          .put("total", entry.total)
          .put("at", entry.at),
      )
    }
    return array.toString()
  }

  @Synchronized
  fun start(name: String, url: String, total: Long): String {
    val id = "dl-${System.currentTimeMillis()}"
    entries.add(0, Entry(id, name, url, "running", 0, total, System.currentTimeMillis()))
    trim()
    persist()
    emit()
    return id
  }

  @Synchronized
  fun progress(id: String, bytes: Long) {
    val entry = entries.firstOrNull { it.id == id } ?: return
    entry.bytes = bytes
    emit()
  }

  @Synchronized
  fun finish(id: String, state: String) {
    val entry = entries.firstOrNull { it.id == id } ?: return
    entry.state = state
    // A failed or cancelled entry has no size worth showing.
    if (state != "saved") entry.bytes = 0
    persist()
    emit()
  }

  @Synchronized
  fun clear() {
    entries.removeAll { it.state != "running" }
    persist()
    emit()
  }

  private fun trim() {
    while (entries.size > 50) entries.removeAt(entries.lastIndex)
  }

  private fun emit() {
    onChange?.invoke(json())
  }

  private fun persist() {
    try {
      val array = JSONArray()
      for (entry in entries) {
        array.put(
          JSONObject()
            .put("id", entry.id)
            .put("name", entry.name)
            .put("url", entry.url)
            .put("state", entry.state)
            .put("bytes", entry.bytes)
            .put("total", entry.total)
            .put("at", entry.at),
        )
      }
      file.writeText(array.toString())
    } catch (error: Exception) {
      // A download that cannot be recorded still downloads.
    }
  }

  private fun load() {
    try {
      if (!file.exists()) return
      val array = JSONArray(file.readText())
      for (index in 0 until array.length()) {
        val item = array.getJSONObject(index)
        entries.add(
          Entry(
            item.optString("id"),
            item.optString("name"),
            item.optString("url"),
            // A download that was running when the app stopped did not finish.
            if (item.optString("state") == "running") "failed" else item.optString("state"),
            item.optLong("bytes"),
            item.optLong("total", -1),
            item.optLong("at"),
          ),
        )
      }
    } catch (error: Exception) {
      entries.clear()
    }
  }
}
