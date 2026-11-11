package xyz.sintfoap.scanner

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Additions made with no connection (a basement pantry, a store with no
 * signal) wait on the phone (Store.queue) and are sent once there's a
 * connection again. Lines the site won't take are kept to fix in the app.
 */
class Sender(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val store = Store(applicationContext)
        if (!store.paired) return@withContext Result.failure()
        while (true) {
            val q = store.queue()
            if (q.length() == 0) return@withContext Result.success()
            val batch = q.getJSONObject(0)
            try {
                val out = store.api().add(batch.optString("store"), batch.getJSONArray("lines"))
                keepFailed(store, batch, out)
            } catch (e: Unpaired) {
                return@withContext Result.failure()     // the app says so, and the batch waits for a new pairing
            } catch (e: Exception) {
                if (isOffline(e)) return@withContext Result.retry()
                // The site said no to the whole batch (it shouldn't): keep its lines to fix rather than lose them.
                val lines = batch.getJSONArray("lines")
                store.addToFix((0 until lines.length()).map { lines.getJSONObject(it).put("store", batch.optString("store")).put("error", e.message ?: "the site wouldn't take it") })
            }
            val left = store.queue()
            store.setQueue(JSONArray().apply { for (i in 1 until left.length()) put(left.get(i)) })
        }
        @Suppress("UNREACHABLE_CODE") Result.success()
    }

    companion object {
        fun keepFailed(store: Store, batch: JSONObject, out: JSONObject) {
            val failed = out.optJSONArray("failed") ?: return
            if (failed.length() == 0) return
            val why = (0 until failed.length()).associate { failed.getJSONObject(it).let { f -> f.optString("key") to f.optString("error") } }
            val lines = batch.getJSONArray("lines")
            store.addToFix((0 until lines.length()).map { lines.getJSONObject(it) }.filter { it.optString("key") in why }
                .map { it.put("store", batch.optString("store")).put("error", why[it.optString("key")]) })
        }

        fun later(context: Context) {
            val work = OneTimeWorkRequestBuilder<Sender>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("send", ExistingWorkPolicy.KEEP, work)
        }
    }
}
