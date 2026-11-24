// ================= StageLoop · android/NativeAudioBridge.kt =================
// Plantilla (no compilada aquí). Package de ejemplo: com.jessper.app — si cambias el package,
// cambia también los nombres Java_com_jessper_app_... en native_audio.cpp.
package com.jessper.app

import android.webkit.JavascriptInterface
import java.util.concurrent.Executors

class NativeAudioBridge {
    companion object { init { System.loadLibrary("stageloop_native") } }

    private val cargador = Executors.newSingleThreadExecutor()   // las cargas pesadas no tocan el hilo del WebView

    fun start(): Boolean = nStart()
    fun shutdown() = nStop()

    // Estos métodos son los que ve JS como window.AndroidAudio.* (mismos nombres que usa audioBridge.js)
    @JavascriptInterface fun play(voice: Int, sample: Int, rate: Float, gain: Float, ch: Int, ls: Int, le: Int) = nPlay(voice, sample, rate, gain, ch, ls, le)
    @JavascriptInterface fun stop(voice: Int, ms: Int) = nStop2(voice, ms)
    @JavascriptInterface fun stopAll(ms: Int) = nStopAll(ms)
    @JavascriptInterface fun setChannelGain(ch: Int, g: Float) = nChGain(ch, g)
    @JavascriptInterface fun setMaster(g: Float) = nMaster(g)
    @JavascriptInterface fun load(id: Int, sr: Int, ch: Int, frames: Int, b64: String) { cargador.execute { nLoad(id, sr, ch, frames, b64) } }
    @JavascriptInterface fun unload(id: Int) = nUnload(id)

    private external fun nStart(): Boolean
    private external fun nStop()
    private external fun nPlay(voice: Int, sample: Int, rate: Float, gain: Float, ch: Int, ls: Int, le: Int)
    private external fun nStop2(voice: Int, ms: Int)
    private external fun nStopAll(ms: Int)
    private external fun nChGain(ch: Int, g: Float)
    private external fun nMaster(g: Float)
    private external fun nLoad(id: Int, sr: Int, ch: Int, frames: Int, b64: String)
    private external fun nUnload(id: Int)
}

/* ---- En tu Activity ----
val bridge = NativeAudioBridge().also { it.start() }
webView.settings.apply { javaScriptEnabled = true; domStorageEnabled = true; mediaPlaybackRequiresUserGesture = false }
webView.addJavascriptInterface(bridge, "AndroidAudio")     // ANTES de loadUrl, para que exista al cargar la página
// IndexedDB y el service worker necesitan un origen https: usa WebViewAssetLoader
// (androidx.webkit) y carga https://appassets.androidplatform.net/assets/Jessper/index.html
*/
