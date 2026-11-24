// ================= StageLoop · android/native_audio.cpp =================
// Oboe (AAudio/OpenSL) + JNI. NO compilado en este entorno: es plantilla para tu proyecto Android.
// Requiere Oboe >= 1.8 (prefab) y la carpeta ../engine.
#include <jni.h>
#include <oboe/Oboe.h>
#include <memory>
#include <string>
#include "AudioEngine.h"

namespace {
std::unique_ptr<sl::Engine> g_engine;
std::shared_ptr<oboe::AudioStream> g_stream;

class Callback : public oboe::AudioStreamDataCallback {
 public:
  oboe::DataCallbackResult onAudioReady(oboe::AudioStream*, void* data, int32_t frames) override {
    g_engine->render(static_cast<float*>(data), frames);   // estéreo float intercalado
    return oboe::DataCallbackResult::Continue;
  }
};
std::shared_ptr<Callback> g_cb = std::make_shared<Callback>();

std::string jstr(JNIEnv* env, jstring s) {
  const char* c = env->GetStringUTFChars(s, nullptr);
  std::string r(c);
  env->ReleaseStringUTFChars(s, c);
  return r;
}
}  // namespace

extern "C" {

JNIEXPORT jboolean JNICALL Java_com_jessper_app_NativeAudioBridge_nStart(JNIEnv*, jobject) {
  if (g_stream) return JNI_TRUE;
  oboe::AudioStreamBuilder b;
  b.setDirection(oboe::Direction::Output)
      ->setPerformanceMode(oboe::PerformanceMode::LowLatency)   // camino rápido de AAudio
      ->setSharingMode(oboe::SharingMode::Exclusive)            // si el dispositivo no lo da, Oboe cae a Shared
      ->setFormat(oboe::AudioFormat::Float)
      ->setChannelCount(oboe::ChannelCount::Stereo)
      ->setUsage(oboe::Usage::Media)
      ->setDataCallback(g_cb);
  // Sin setSampleRate: se usa la frecuencia nativa del dispositivo (sin remuestreo del sistema).
  if (b.openStream(g_stream) != oboe::Result::OK) return JNI_FALSE;
  g_engine = std::make_unique<sl::Engine>(g_stream->getSampleRate());
  g_stream->setBufferSizeInFrames(g_stream->getFramesPerBurst() * 2);   // 2 ráfagas: mínimo estable
  // TODO producción: AudioStreamErrorCallback::onErrorAfterClose → reabrir si se desconectan los audífonos.
  return g_stream->requestStart() == oboe::Result::OK ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL Java_com_jessper_app_NativeAudioBridge_nStop(JNIEnv*, jobject) {
  if (g_stream) { g_stream->stop(); g_stream->close(); g_stream.reset(); }
  g_engine.reset();
}

// ---- Mensajes de JS: todos son "encolar y volver" (no bloquean el hilo del WebView) ----
JNIEXPORT void JNICALL Java_com_jessper_app_NativeAudioBridge_nPlay(JNIEnv*, jobject, jint voice, jint sample,
    jfloat rate, jfloat gain, jint ch, jint ls, jint le) { if (g_engine) g_engine->play(voice, sample, rate, gain, ch, ls, le); }
JNIEXPORT void JNICALL Java_com_jessper_app_NativeAudioBridge_nStop2(JNIEnv*, jobject, jint voice, jint ms) { if (g_engine) g_engine->stop(voice, ms); }
JNIEXPORT void JNICALL Java_com_jessper_app_NativeAudioBridge_nStopAll(JNIEnv*, jobject, jint ms) { if (g_engine) g_engine->stopAll(ms); }
JNIEXPORT void JNICALL Java_com_jessper_app_NativeAudioBridge_nChGain(JNIEnv*, jobject, jint ch, jfloat g) { if (g_engine) g_engine->setChannelGain(ch, g); }
JNIEXPORT void JNICALL Java_com_jessper_app_NativeAudioBridge_nMaster(JNIEnv*, jobject, jfloat g) { if (g_engine) g_engine->setMaster(g); }

// ---- Precarga: se llama desde un hilo de fondo (ver Kotlin), nunca al pulsar ----
JNIEXPORT void JNICALL Java_com_jessper_app_NativeAudioBridge_nLoad(JNIEnv* env, jobject, jint id, jint sr, jint ch,
    jint frames, jstring b64) { if (g_engine) { g_engine->loadSampleInt16B64(id, sr, ch, frames, jstr(env, b64)); g_engine->collectGarbage(); } }
JNIEXPORT void JNICALL Java_com_jessper_app_NativeAudioBridge_nUnload(JNIEnv*, jobject, jint id) { if (g_engine) g_engine->unloadSample(id); }

}  // extern "C"
