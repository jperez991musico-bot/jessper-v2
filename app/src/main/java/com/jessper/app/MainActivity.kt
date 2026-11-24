package com.jessper.app

import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader

class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private var bridge: NativeAudioBridge? = null
    private var pendingChooser: ValueCallback<Array<Uri>>? = null
    private var ultimoAtras = 0L
    private var paginaCargada = false
    private val ui = Handler(Looper.getMainLooper())

    // Selector de archivos para los <input type="file"> de la app (+ WAV, + SF2…)
    private val selector = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        pendingChooser?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data))
        pendingChooser = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Log.i(TAG, "onCreate")
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        web = WebView(this)
        web.setBackgroundColor(0xFF16181C.toInt())      // mismo gris oscuro de la app: si ves ESTE color, el WebView sí existe
        setContentView(web)
        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
        }

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) { Log.i(TAG, "pagina: empieza $url") }
            override fun onPageFinished(view: WebView, url: String) { Log.i(TAG, "pagina: terminada $url") }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                Log.e(TAG, "error cargando ${request.url}: ${error.description}")
                if (request.isForMainFrame) {
                    view.loadData("<body style='background:#16181c;color:#fff;font:16px sans-serif;padding:24px'>" +
                        "<h3>No se pudo cargar la app</h3><p>${error.description}</p><p>${request.url}</p></body>", "text/html", "utf-8")
                }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(w: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                pendingChooser?.onReceiveValue(null)
                pendingChooser = cb
                return try { selector.launch(p.createIntent()); true }
                catch (e: Exception) { pendingChooser = null; false }
            }
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d("JessperJS", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }

        // Motor nativo (Oboe) en SEGUNDO PLANO: si tarda o falla, la app carga igual con Web Audio.
        Thread({
            var b: NativeAudioBridge? = null
            var ok = false
            try { b = NativeAudioBridge(); ok = b.start() }
            catch (t: Throwable) { Log.e(TAG, "Motor nativo no disponible", t) }
            runOnUiThread {
                when {
                    isDestroyed -> if (ok) b?.shutdown()
                    paginaCargada -> { Log.w(TAG, "el motor nativo llego tarde; se apaga y sigue Web Audio"); if (ok) b?.shutdown() }
                    else -> { if (ok) bridge = b; cargarPagina(ok) }
                }
            }
        }, "jessper-audio").start()
        ui.postDelayed({ if (!paginaCargada) { Log.w(TAG, "el motor nativo tardo mas de 3 s: sigo con Web Audio"); cargarPagina(false) } }, 3000)

        // Escenario: un "atrás" accidental no debe cerrar la app. Hay que pulsarlo dos veces.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val t = SystemClock.elapsedRealtime()
                if (t - ultimoAtras < 2000) finish()
                else { ultimoAtras = t; Toast.makeText(this@MainActivity, "Pulsa atrás otra vez para salir", Toast.LENGTH_SHORT).show() }
            }
        })
    }

    private fun cargarPagina(conNativo: Boolean) {
        if (paginaCargada) return
        paginaCargada = true
        Log.i(TAG, "Motor nativo: " + if (conNativo) "ACTIVO (Oboe)" else "NO (Web Audio)")
        // ANTES de loadUrl, para que window.AndroidAudio exista cuando audioBridge.js arranque
        if (conNativo) bridge?.let { web.addJavascriptInterface(it, "AndroidAudio") }
        web.loadUrl("https://appassets.androidplatform.net/assets/Jessper/index.html")
    }

    override fun onResume() {
        super.onResume()
        WindowCompat.getInsetsController(window, web).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        bridge?.shutdown()
        web.destroy()
        super.onDestroy()
    }

    private companion object { const val TAG = "Jessper" }
}
