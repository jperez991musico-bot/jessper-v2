// ================= StageLoop · AudioEngine.cpp =================
#include "AudioEngine.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

namespace sl {

static int64_t nowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

Engine::Engine(int outSampleRate) : sr_(outSampleRate > 0 ? outSampleRate : 48000) {
  for (auto& b : bank_) b.store(nullptr, std::memory_order_relaxed);
  for (int i = 0; i < kChannels; ++i) chCur_[i] = chTgt_[i] = 1.0f;
}

Engine::~Engine() {
  // El stream de audio debe estar cerrado antes de destruir el motor.
  for (auto& b : bank_) delete b.load();
  for (auto& g : grave_) delete g.first;
}

// ---------------------------------------------------------------------------------------------
// Carga de samples (fuera del hilo de audio)
// ---------------------------------------------------------------------------------------------
// Primer frame audible (> -60 dB) dentro de los primeros 300 ms, dejando 1 ms de margen.
static int findStart(const Sample& s) {
  const int maxF = std::min(s.frames, static_cast<int>(s.srcRate * 0.3));
  for (int i = 0; i < maxF; ++i)
    for (int c = 0; c < s.channels; ++c)
      if (std::fabs(s.data[static_cast<size_t>(i) * s.channels + c]) > 0.001f) {
        const int start = i - static_cast<int>(s.srcRate * 0.001);
        return start < static_cast<int>(s.srcRate * 0.002) ? 0 : start;
      }
  return 0;
}

bool Engine::loadSample(int id, const float* pcm, int frames, int channels, int srcRate) {
  if (id < 0 || id >= kMaxSamples || !pcm || frames <= 0 || channels < 1 || channels > 2 || srcRate <= 0)
    return false;
  auto* s = new Sample();
  s->data.assign(pcm, pcm + static_cast<size_t>(frames) * channels);
  s->channels = channels;
  s->frames = frames;
  s->srcRate = srcRate;
  s->startFrame = findStart(*s);
  const Sample* old = bank_[id].exchange(s, std::memory_order_acq_rel);
  if (old) { std::lock_guard<std::mutex> lk(graveMutex_); grave_.emplace_back(old, nowMs()); }
  return true;
}

static int b64val(unsigned char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

bool Engine::loadSampleInt16B64(int id, int srcRate, int channels, int frames, const std::string& b64) {
  std::vector<uint8_t> bytes;
  bytes.reserve(b64.size() / 4 * 3);
  uint32_t acc = 0; int bits = 0;
  for (unsigned char c : b64) {
    int v = b64val(c);
    if (v < 0) continue;                       // ignora '=', saltos de línea…
    acc = (acc << 6) | static_cast<uint32_t>(v); bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push_back(static_cast<uint8_t>((acc >> bits) & 0xFF)); }
  }
  const size_t n = static_cast<size_t>(frames) * channels;
  if (channels < 1 || frames <= 0 || bytes.size() < n * 2) return false;
  std::vector<float> f(n);
  for (size_t i = 0; i < n; ++i) {             // Int16 little-endian → float
    int16_t s = static_cast<int16_t>(bytes[2 * i] | (bytes[2 * i + 1] << 8));
    f[i] = s / 32768.0f;
  }
  return loadSample(id, f.data(), frames, channels, srcRate);
}

void Engine::unloadSample(int id) {
  if (id < 0 || id >= kMaxSamples) return;
  const Sample* old = bank_[id].exchange(nullptr, std::memory_order_acq_rel);
  if (old) { std::lock_guard<std::mutex> lk(graveMutex_); grave_.emplace_back(old, nowMs()); }
}

void Engine::collectGarbage() {
  // Una voz podría estar usando el sample justo cuando se descarga: se espera 2 s (los samples
  // de piano largos terminan antes o están en release) antes de liberar la memoria.
  std::lock_guard<std::mutex> lk(graveMutex_);
  const int64_t limite = nowMs() - 2000;
  auto it = std::remove_if(grave_.begin(), grave_.end(), [&](auto& g) {
    if (g.second > limite) return false;
    delete g.first;
    return true;
  });
  grave_.erase(it, grave_.end());
}

// ---------------------------------------------------------------------------------------------
// Cola de comandos
// ---------------------------------------------------------------------------------------------
bool Engine::push(const Cmd& c) {
  while (prodLock_.test_and_set(std::memory_order_acquire)) { /* spin: sección de pocos ns */ }
  const uint32_t h = head_.load(std::memory_order_relaxed);
  const uint32_t t = tail_.load(std::memory_order_acquire);
  bool ok = (h - t) < static_cast<uint32_t>(kQueueSize);
  if (ok) { queue_[h & (kQueueSize - 1)] = c; head_.store(h + 1, std::memory_order_release); }
  prodLock_.clear(std::memory_order_release);
  return ok;                                   // false = cola llena: se descarta el comando
}

bool Engine::play(int voiceId, int sampleId, float rate, float gain, int ch, int ls, int le) {
  return push({Op::Play, voiceId, sampleId, ch, ls, le, rate, gain});
}
bool Engine::stop(int voiceId, int releaseMs) { return push({Op::Stop, voiceId, 0, 0, 0, 0, static_cast<float>(releaseMs), 0}); }
bool Engine::stopAll(int releaseMs) { return push({Op::StopAll, 0, 0, 0, 0, 0, static_cast<float>(releaseMs), 0}); }
bool Engine::setChannelGain(int ch, float g) { return push({Op::ChGain, 0, 0, ch, 0, 0, g, 0}); }
bool Engine::setMaster(float g) { return push({Op::Master, 0, 0, 0, 0, 0, g, 0}); }

void Engine::drain() {
  uint32_t t = tail_.load(std::memory_order_relaxed);
  const uint32_t h = head_.load(std::memory_order_acquire);
  for (; t != h; ++t) {
    const Cmd& c = queue_[t & (kQueueSize - 1)];
    switch (c.op) {
      case Op::Play: startVoice(c); break;
      case Op::Stop:
        for (auto& v : voices_)
          if (v.active && !v.releasing && v.id == c.voice) {
            const float frames = std::max(1.0f, c.a * 0.001f * sr_);
            v.releasing = true;
            v.relDec = std::max(v.cur, 1e-4f) / frames;
            break;
          }
        break;
      case Op::StopAll:
        for (auto& v : voices_)
          if (v.active && !v.releasing) {
            v.releasing = true;
            v.relDec = std::max(v.cur, 1e-4f) / std::max(1.0f, c.a * 0.001f * sr_);
          }
        break;
      case Op::ChGain: if (c.ch >= 0 && c.ch < kChannels) chTgt_[c.ch] = c.a; break;
      case Op::Master: mTgt_ = c.a; break;
    }
  }
  tail_.store(t, std::memory_order_release);
}

void Engine::startVoice(const Cmd& c) {
  if (c.sample < 0 || c.sample >= kMaxSamples) return;
  const Sample* s = bank_[c.sample].load(std::memory_order_acquire);
  if (!s) return;                              // aún no cargado: se ignora (JS usa Web Audio en ese caso)
  Voice* slot = nullptr;
  for (auto& v : voices_) if (!v.active) { slot = &v; break; }
  if (!slot) {                                 // sin voces libres: se roba la más antigua
    slot = &voices_[0];
    for (auto& v : voices_) if (v.seq < slot->seq) slot = &v;
  }
  Voice& v = *slot;
  v = Voice();
  v.active = true;
  v.id = c.voice;
  v.s = s;
  v.ch = std::min(std::max(c.ch, 0), kChannels - 1);
  v.gain = c.b;
  v.cur = 0.0f;
  v.atkInc = v.gain / std::max(1.0f, 0.004f * sr_);          // 4 ms anti-click (igual que Web Audio)
  v.step = static_cast<double>(c.a) * s->srcRate / sr_;
  v.seq = ++seq_;
  v.pos = s->startFrame;
  const int le = std::min(c.le, s->frames);
  if (le > c.ls && c.ls >= 0) { v.loop = true; v.ls = c.ls; v.le = le; }
}

// ---------------------------------------------------------------------------------------------
// Mezcla (hilo de audio)
// ---------------------------------------------------------------------------------------------
void Engine::mixVoice(Voice& v, float* out, int frames, const float* chStart, const float* chInc) {
  const Sample& s = *v.s;
  const float* d = s.data.data();
  const bool st = s.channels == 2;
  for (int i = 0; i < frames; ++i) {
    if (v.releasing) { v.cur -= v.relDec; if (v.cur <= 0.0f) { v.active = false; return; } }
    else if (v.cur < v.gain) { v.cur += v.atkInc; if (v.cur > v.gain) v.cur = v.gain; }

    int64_t i0 = static_cast<int64_t>(v.pos);
    if (i0 >= s.frames) { v.active = false; return; }          // el sample terminó
    int64_t i1 = i0 + 1;
    if (v.loop && i1 >= v.le) i1 = v.ls;
    else if (i1 >= s.frames) i1 = s.frames - 1;
    const float fr = static_cast<float>(v.pos - static_cast<double>(i0));

    float l, r;
    if (st) {
      l = d[2 * i0] + (d[2 * i1] - d[2 * i0]) * fr;
      r = d[2 * i0 + 1] + (d[2 * i1 + 1] - d[2 * i0 + 1]) * fr;
    } else {
      l = r = d[i0] + (d[i1] - d[i0]) * fr;
    }
    const float g = v.cur * (chStart[v.ch] + chInc[v.ch] * i);
    out[2 * i] += l * g;
    out[2 * i + 1] += r * g;

    v.pos += v.step;
    if (v.loop) while (v.pos >= v.le) v.pos -= (v.le - v.ls);
  }
}

static inline float softLimit(float x) {       // transparente hasta 0.95, luego curva suave
  const float t = 0.95f;
  const float a = std::fabs(x);
  if (a <= t) return x;
  const float y = t + (1.0f - t) * std::tanh((a - t) / (1.0f - t));
  return x < 0 ? -y : y;
}

void Engine::render(float* out, int frames) {
  drain();
  std::memset(out, 0, sizeof(float) * 2 * static_cast<size_t>(frames));

  float chStart[kChannels], chInc[kChannels];
  for (int c = 0; c < kChannels; ++c) {         // los cambios de volumen se suavizan dentro del bloque
    chStart[c] = chCur_[c];
    chInc[c] = (chTgt_[c] - chCur_[c]) / static_cast<float>(frames);
    chCur_[c] = chTgt_[c];
  }
  const float mStart = mCur_, mInc = (mTgt_ - mCur_) / static_cast<float>(frames);
  mCur_ = mTgt_;

  int n = 0;
  for (auto& v : voices_) {
    if (!v.active) continue;
    mixVoice(v, out, frames, chStart, chInc);
    if (v.active) ++n;
  }
  active_.store(n, std::memory_order_relaxed);

  for (int i = 0; i < frames; ++i) {
    const float m = mStart + mInc * i;
    out[2 * i] = softLimit(out[2 * i] * m);
    out[2 * i + 1] = softLimit(out[2 * i + 1] * m);
  }
}

}  // namespace sl
