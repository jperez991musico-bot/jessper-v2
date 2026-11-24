// ================= StageLoop · AudioEngine.h =================
// Motor de audio PORTABLE (sin dependencias de plataforma): lo comparten Android (Oboe),
// iOS (Core Audio) y PC (miniaudio / WASAPI / CoreAudio). Cada plataforma solo hace dos cosas:
//   1) abrir un stream de salida y llamar a engine.render(buffer, frames) dentro de su callback;
//   2) reenviar los mensajes de JS a engine.play()/stop()/... (ver native/README.md).
//
// REGLAS DE TIEMPO REAL (hilo de audio):
//   · render() NO reserva memoria, NO usa mutex, NO imprime, NO llama al sistema.
//   · Todo lo que llega desde JS entra por una cola sin bloqueo y se aplica al inicio de render().
//   · Los samples se cargan ANTES (loadSample*) y viven en RAM; disparar una nota solo copia 32 bytes.
#pragma once
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

namespace sl {

struct Sample {
  std::vector<float> data;      // intercalado: L R L R… (o mono)
  int channels = 1;             // 1 o 2
  int frames = 0;
  int srcRate = 48000;
  int startFrame = 0;           // salta el silencio inicial (como latencia.js); NO mueve los puntos de loop
};

class Engine {
 public:
  static constexpr int kMaxVoices  = 96;     // igual que el límite de polifonía de app.js
  static constexpr int kMaxSamples = 8192;   // ids numéricos que asigna audioBridge.js
  static constexpr int kChannels   = 8;      // CH1…CH8 del mixer
  static constexpr int kQueueSize  = 1024;   // comandos pendientes (potencia de 2)

  explicit Engine(int outSampleRate);
  ~Engine();
  Engine(const Engine&) = delete;
  Engine& operator=(const Engine&) = delete;

  // ---- Hilo de CARGA (no tiempo real): precarga de samples en RAM -------------------------
  bool loadSample(int id, const float* interleaved, int frames, int channels, int srcRate);
  bool loadSampleInt16B64(int id, int srcRate, int channels, int frames, const std::string& b64);
  void unloadSample(int id);        // se libera de verdad ~2 s después (ver collectGarbage)
  void collectGarbage();            // llámalo de vez en cuando desde un hilo NO de audio

  // ---- Cualquier hilo (p. ej. el hilo del puente JS): solo encola, no bloquea --------------
  // rate = playbackRate de Web Audio (2^((nota-raíz)/12)); gain ya incluye volumen×velocity.
  // loopEnd <= loopStart → sin loop (las posiciones están en frames del sample).
  bool play(int voiceId, int sampleId, float rate, float gain, int ch, int loopStart, int loopEnd);
  bool stop(int voiceId, int releaseMs);
  bool stopAll(int releaseMs);
  bool setChannelGain(int ch, float g);
  bool setMaster(float g);

  // ---- Hilo de AUDIO: rellena `out` con `frames` frames estéreo intercalados ---------------
  void render(float* out, int frames);

  int activeVoices() const { return active_.load(std::memory_order_relaxed); }
  int sampleRate() const { return sr_; }

 private:
  enum class Op : uint8_t { Play, Stop, StopAll, ChGain, Master };
  struct Cmd { Op op; int voice; int sample; int ch; int ls; int le; float a; float b; };
  struct Voice {
    bool active = false, releasing = false, loop = false;
    int id = 0, ch = 0, ls = 0, le = 0;
    const Sample* s = nullptr;
    double pos = 0, step = 1;
    float gain = 1, cur = 0, atkInc = 0, relDec = 0;
    uint64_t seq = 0;
  };

  bool push(const Cmd& c);
  void drain();
  void startVoice(const Cmd& c);
  void mixVoice(Voice& v, float* out, int frames, const float* chStart, const float* chInc);

  const int sr_;
  // cola: varios productores (spinlock corto), un consumidor (audio)
  Cmd queue_[kQueueSize];
  std::atomic<uint32_t> head_{0}, tail_{0};
  std::atomic_flag prodLock_ = ATOMIC_FLAG_INIT;

  std::atomic<const Sample*> bank_[kMaxSamples];
  std::mutex graveMutex_;
  std::vector<std::pair<const Sample*, int64_t>> grave_;

  Voice voices_[kMaxVoices];
  uint64_t seq_ = 0;
  float chCur_[kChannels], chTgt_[kChannels], mCur_ = 0.9f, mTgt_ = 0.9f;
  std::atomic<int> active_{0};
};

}  // namespace sl
