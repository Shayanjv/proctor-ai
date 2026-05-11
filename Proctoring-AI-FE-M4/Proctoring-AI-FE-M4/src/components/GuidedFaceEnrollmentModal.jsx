import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Camera, CheckCircle2, ChevronLeft, ChevronRight, Dot, RefreshCw, ScanFace } from 'lucide-react';

import Modal from './Modal';
import { authService } from '../services/authService';

const POSE_STEPS = [
  {
    key: 'front',
    label: 'Front',
    title: 'Look straight at the camera',
    helper: 'Keep your full face inside the frame and hold still when the guide turns green.',
  },
  {
    key: 'left',
    label: 'Side 1',
    title: 'Turn slightly to one side',
    helper: 'Turn a little to either side and keep your full face inside the frame.',
  },
  {
    key: 'right',
    label: 'Side 2',
    title: 'Turn to the opposite side',
    helper: 'Turn to the other side from your previous side photo and stay inside the frame.',
  },
];

const ANALYSIS_INTERVAL_MS = 350;        // faster polling for both modes
const AUTO_CAPTURE_HOLD_MS = 1500;       // enrollment: 1.5s hold
const AUTO_CAPTURE_HOLD_LOGIN_MS = 1500; // login: 1.5s hold
const LOGIN_CAMERA_SETTLE_MS = 1200;     // wait briefly after camera starts before countdown
const AUTO_CAPTURE_GRACE_MS = 800;
const MANUAL_FALLBACK_DELAY_MS = 4000;   // enrollment: show manual after 4s
const MANUAL_FALLBACK_DELAY_LOGIN_MS = 0; // login: show manual button IMMEDIATELY

const QUALITY_MIN_BRIGHTNESS = 42;
const QUALITY_MAX_BRIGHTNESS = 235;
const QUALITY_MIN_CONTRAST = 14;
// Laplacian variance — values typical for in-focus webcam grabs sit at 60+.
// Anything under ~12 is genuinely blurred (motion / out of focus).
const QUALITY_MIN_LAPLACIAN_VARIANCE = 12;
// Burst capture parameters used when enforceQuality is enabled. We sample a
// few frames in quick succession and keep the sharpest one — this avoids
// rejecting a perfectly valid attempt because of a single motion-blurred frame.
const BURST_FRAME_COUNT = 6;
const BURST_INTERVAL_MS = 90;

const GUIDE_COLORS = {
  green: {
    frame: 'border-emerald-400',
    glow: 'shadow-[0_0_0_1px_rgba(74,222,128,0.45),0_0_40px_rgba(16,185,129,0.28)]',
    chip: 'bg-emerald-500/20 text-emerald-100 border-emerald-400/40',
    text: 'text-emerald-200',
    progress: 'bg-emerald-400',
  },
  yellow: {
    frame: 'border-amber-300',
    glow: 'shadow-[0_0_0_1px_rgba(252,211,77,0.4),0_0_36px_rgba(245,158,11,0.2)]',
    chip: 'bg-amber-500/20 text-amber-50 border-amber-300/40',
    text: 'text-amber-100',
    progress: 'bg-amber-300',
  },
  red: {
    frame: 'border-rose-400',
    glow: 'shadow-[0_0_0_1px_rgba(251,113,133,0.4),0_0_34px_rgba(244,63,94,0.22)]',
    chip: 'bg-rose-500/20 text-rose-50 border-rose-400/40',
    text: 'text-rose-100',
    progress: 'bg-rose-400',
  },
};

// Compute basic luminance statistics + Laplacian variance for a frame. The
// Laplacian variance is the standard "is this image blurry?" metric (used by
// OpenCV's classic blur detector). It is the variance of the discrete
// 4-neighbour Laplacian over the frame: in-focus edges produce high variance,
// blurred frames produce near-uniform Laplacian responses ⇒ low variance.
const measureFrame = (context, canvas) => {
  const SAMPLE_STEP = 6;
  const { width, height } = canvas;
  const data = context.getImageData(0, 0, width, height).data;

  let samples = 0;
  let sum = 0;
  let sumSq = 0;
  let lapSum = 0;
  let lapSumSq = 0;

  for (let y = 1; y < height - 1; y += SAMPLE_STEP) {
    for (let x = 1; x < width - 1; x += SAMPLE_STEP) {
      const idx = (y * width + x) * 4;
      const idxL = (y * width + (x - 1)) * 4;
      const idxR = (y * width + (x + 1)) * 4;
      const idxU = ((y - 1) * width + x) * 4;
      const idxD = ((y + 1) * width + x) * 4;

      const g  = (data[idx]   + data[idx + 1]   + data[idx + 2])   / 3;
      const gL = (data[idxL]  + data[idxL + 1]  + data[idxL + 2])  / 3;
      const gR = (data[idxR]  + data[idxR + 1]  + data[idxR + 2])  / 3;
      const gU = (data[idxU]  + data[idxU + 1]  + data[idxU + 2])  / 3;
      const gD = (data[idxD]  + data[idxD + 1]  + data[idxD + 2])  / 3;

      const lap = (4 * g) - gL - gR - gU - gD;

      sum += g;
      sumSq += g * g;
      lapSum += lap;
      lapSumSq += lap * lap;
      samples += 1;
    }
  }

  if (samples === 0) {
    return { samples: 0 };
  }

  const mean = sum / samples;
  const contrast = Math.sqrt(Math.max(0, (sumSq / samples) - (mean * mean)));
  const lapMean = lapSum / samples;
  const sharpness = Math.max(0, (lapSumSq / samples) - (lapMean * lapMean));

  return { samples, mean, contrast, sharpness };
};

const evaluateImageQuality = (context, canvas) => {
  const stats = measureFrame(context, canvas);
  if (!stats.samples) {
    return { ok: false, message: 'Unable to assess capture quality. Please retry.' };
  }
  const { mean, contrast, sharpness } = stats;

  if (mean < QUALITY_MIN_BRIGHTNESS) {
    return { ok: false, message: 'Image is too dark. Move to better lighting and retry.' };
  }
  if (mean > QUALITY_MAX_BRIGHTNESS) {
    return { ok: false, message: 'Image is too bright. Reduce glare and retry.' };
  }
  if (contrast < QUALITY_MIN_CONTRAST) {
    return { ok: false, message: 'Face contrast is too low. Improve lighting and retry.' };
  }
  if (sharpness < QUALITY_MIN_LAPLACIAN_VARIANCE) {
    return { ok: false, message: 'Image looks blurry. Hold still and retry capture.' };
  }

  return { ok: true, sharpness };
};

// Apply a light, conservative unsharp mask to recover gradient on
// soft / heavily-denoised webcam frames WITHOUT inventing structure.
// We only sharpen where the image is genuinely soft (small kernel,
// modest amount), so face geometry is preserved for embedding.
const applyUnsharpMask = (imageData, width, height, amount = 0.45) => {
  const src = imageData.data;
  const out = new Uint8ClampedArray(src.length);
  out.set(src);

  // 3x3 Gaussian-ish blur via separable mean (cheap, good enough as the
  // low-pass component for an unsharp mask).
  const blur = new Uint8ClampedArray(src.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const sum =
          src[o - width * 4 - 4 + c] + src[o - width * 4 + c] + src[o - width * 4 + 4 + c] +
          src[o - 4 + c]             + src[o + c]             + src[o + 4 + c] +
          src[o + width * 4 - 4 + c] + src[o + width * 4 + c] + src[o + width * 4 + 4 + c];
        blur[o + c] = sum / 9;
      }
      blur[o + 3] = src[o + 3];
    }
  }

  // out = clamp(src + amount * (src - blur))
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const v = src[i + c] + amount * (src[i + c] - blur[i + c]);
      out[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    out[i + 3] = src[i + 3];
  }
  return new ImageData(out, width, height);
};

const enhanceFrameForLowQualityCamera = (context, canvas) => {
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  let luminanceSum = 0;
  for (let i = 0; i < data.length; i += 4) {
    luminanceSum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }

  const pixelCount = Math.max(1, data.length / 4);
  const mean = luminanceSum / pixelCount;
  const gain = mean < 95 ? 1.2 : mean > 185 ? 0.92 : 1.05;
  const offset = mean < 80 ? 10 : mean > 205 ? -8 : 0;
  const contrast = mean < 95 ? 1.12 : 1.06;

  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.max(0, Math.min(255, (((data[i] - 128) * contrast) + 128) * gain + offset));
    data[i + 1] = Math.max(0, Math.min(255, (((data[i + 1] - 128) * contrast) + 128) * gain + offset));
    data[i + 2] = Math.max(0, Math.min(255, (((data[i + 2] - 128) * contrast) + 128) * gain + offset));
  }

  // Light unsharp mask — strictly an edge-recovery pass, not a generative one.
  const sharpened = applyUnsharpMask(imageData, canvas.width, canvas.height, 0.45);
  context.putImageData(sharpened, 0, 0);
};

// Grab a single frame from <video> into a fresh canvas. Helper used both for
// single-shot capture and as the per-iteration step of the burst capture below.
const grabFrameToCanvas = (videoElement) => {
  const MAX_CAPTURE_WIDTH = 960;
  const scale = Math.min(1, MAX_CAPTURE_WIDTH / videoElement.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(videoElement.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(videoElement.videoHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Unable to prepare image capture.');
  }
  context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
  return { canvas, context };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const captureFrameFromVideo = async (videoElement, options = {}) => {
  const {
    enforceQuality = false,
    enhanceFrame = true,
    burstFrames = enforceQuality ? BURST_FRAME_COUNT : 1,
    burstIntervalMs = BURST_INTERVAL_MS,
  } = options;

  if (!videoElement || !videoElement.videoWidth || !videoElement.videoHeight) {
    throw new Error('Camera preview is not ready yet.');
  }

  // ── Burst capture: sample a few raw frames so a single motion-blurred
  // frame doesn't fail the user. We measure each on raw pixels (pre-enhance,
  // pre-encode) and keep only the sharpest by Laplacian variance. The
  // enhancement / unsharp pass is applied to the winner only — much cheaper
  // and preserves the embedding-relevant geometry.
  let best = null;
  let bestStats = null;

  for (let i = 0; i < Math.max(1, burstFrames); i += 1) {
    const grab = grabFrameToCanvas(videoElement);
    const stats = measureFrame(grab.context, grab.canvas);
    if (stats.samples) {
      if (!bestStats || (stats.sharpness ?? 0) > (bestStats.sharpness ?? 0)) {
        best = grab;
        bestStats = stats;
      }
    } else if (!best) {
      best = grab;
      bestStats = stats;
    }
    if (i < burstFrames - 1) {
      // Small delay so we actually sample distinct camera frames (most
      // webcams produce a new frame every ~33-66ms at 30/60 fps).
      // eslint-disable-next-line no-await-in-loop
      await sleep(burstIntervalMs);
    }
  }

  if (!best) {
    throw new Error('Camera preview is not ready yet.');
  }

  const { canvas, context } = best;

  if (enhanceFrame) {
    enhanceFrameForLowQualityCamera(context, canvas);
  }

  if (enforceQuality) {
    // Re-evaluate after enhancement so the threshold reflects what we actually
    // ship to the verifier.
    const quality = evaluateImageQuality(context, canvas);
    if (!quality.ok) {
      throw new Error(quality.message);
    }
  }

  const blob = await new Promise((resolve) => {
    canvas.toBlob((value) => resolve(value), 'image/jpeg', 0.85);
  });

  if (!blob) {
    throw new Error('Failed to capture face image.');
  }

  return {
    blob,
    previewUrl: canvas.toDataURL('image/jpeg', 0.85),
    sharpness: bestStats?.sharpness,
  };
};

const getYawSideSign = (analysisResult) => {
  const yaw = Number(analysisResult?.metrics?.yaw);
  if (!Number.isFinite(yaw) || Math.abs(yaw) < 6) {
    return 0;
  }
  return yaw > 0 ? 1 : -1;
};

const PoseIcon = ({ poseKey, className = 'h-5 w-5' }) => {
  if (poseKey === 'left') {
    return <ChevronLeft className={className} />;
  }
  if (poseKey === 'right') {
    return <ChevronRight className={className} />;
  }
  return <ScanFace className={className} />;
};

const GuideLines = ({ poseKey, colorKey }) => {
  const palette = GUIDE_COLORS[colorKey] || GUIDE_COLORS.red;

  return (
    <>
      <div className="absolute inset-x-0 top-0 h-[10%] bg-slate-950/42" />
      <div className="absolute inset-x-0 bottom-0 h-[10%] bg-slate-950/42" />
      <div className="absolute bottom-[10%] left-0 top-[10%] w-[28%] bg-slate-950/42" />
      <div className="absolute bottom-[10%] right-0 top-[10%] w-[28%] bg-slate-950/42" />

      <div
        className={`absolute left-1/2 top-1/2 h-[80%] w-[44%] -translate-x-1/2 -translate-y-1/2 rounded-[36px] border-[3px] ${palette.frame} ${palette.glow}`}
      />

      <div className={`absolute left-[28%] top-[10%] h-8 w-8 rounded-tl-[24px] border-l-[4px] border-t-[4px] ${palette.frame}`} />
      <div className={`absolute right-[28%] top-[10%] h-8 w-8 rounded-tr-[24px] border-r-[4px] border-t-[4px] ${palette.frame}`} />
      <div className={`absolute bottom-[10%] left-[28%] h-8 w-8 rounded-bl-[24px] border-b-[4px] border-l-[4px] ${palette.frame}`} />
      <div className={`absolute bottom-[10%] right-[28%] h-8 w-8 rounded-br-[24px] border-b-[4px] border-r-[4px] ${palette.frame}`} />

      <div className={`absolute left-1/2 top-[18%] h-[64%] w-px -translate-x-1/2 ${palette.progress} opacity-40`} />
      <div className={`absolute left-[33%] right-[33%] top-[32%] h-px ${palette.progress} opacity-40`} />
      <div className={`absolute left-[33%] right-[33%] top-[50%] h-px ${palette.progress} opacity-50`} />
      <div className={`absolute left-[33%] right-[33%] bottom-[28%] h-px ${palette.progress} opacity-40`} />

      <div className="absolute left-1/2 top-[20%] -translate-x-1/2 rounded-full border border-white/10 bg-slate-950/65 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/80">
        Full face inside frame
      </div>

      {poseKey === 'left' && (
        <>
          <div className={`absolute left-[21%] top-1/2 h-[24%] w-[4px] -translate-y-1/2 rounded-full ${palette.progress}`} />
          <div className="absolute left-[11%] top-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-slate-950/55 p-2 text-white/80">
            <ChevronLeft className="h-7 w-7" />
          </div>
        </>
      )}
      {poseKey === 'right' && (
        <>
          <div className={`absolute right-[21%] top-1/2 h-[24%] w-[4px] -translate-y-1/2 rounded-full ${palette.progress}`} />
          <div className="absolute right-[11%] top-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-slate-950/55 p-2 text-white/80">
            <ChevronRight className="h-7 w-7" />
          </div>
        </>
      )}

      <div className="absolute inset-x-0 top-4 flex justify-center">
        <div className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] ${palette.chip}`}>
          {poseKey} guide
        </div>
      </div>
    </>
  );
};

const GuidedFaceEnrollmentModal = ({
  isOpen,
  onClose,
  onComplete,
  title = 'Capture front, left, and right references',
  description = 'Fit your full face inside the camera frame. When the frame turns green, hold still for 1.5 seconds and the photo is captured automatically.',
  badgeLabel = 'Guided Face Enrollment',
  /** 'enrollment' = strict pose match; 'login' = relaxed side poses, server-driven readiness (no fake green) */
  variant = 'enrollment',
  /** Optional server-provided randomized pose order: ['front','left','right'] */
  poseOrder = null,
}) => {
  const videoRef = useRef(null);
  const captureRequestInFlightRef = useRef(false);
  const autoCaptureLockRef = useRef(false);
  const stepStartedAtRef = useRef(0);
  const readySinceRef = useRef(null);
  const lastReadyAtRef = useRef(null);
  const pollingIntervalRef = useRef(null);
  // Login-variant: lightweight local countdown (no backend API call)
  const loginTimerRef = useRef(null);
  const cameraLiveRef = useRef(false);

  const [cameraError, setCameraError] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [capturedShots, setCapturedShots] = useState({});
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [captureMessage, setCaptureMessage] = useState('');
  const [isCameraStarting, setIsCameraStarting] = useState(false);
  const [isManualCaptureLoading, setIsManualCaptureLoading] = useState(false);
  const [autoCaptureProgress, setAutoCaptureProgress] = useState(0);
  const [autoCaptureRemainingMs, setAutoCaptureRemainingMs] = useState(AUTO_CAPTURE_HOLD_MS);
  const [showManualFallback, setShowManualFallback] = useState(false);

  const orderedSteps = useMemo(() => {
    // Login variant: single front-facing photo only — no pose dance.
    if (variant === 'login') {
      return [POSE_STEPS[0]]; // Only 'front'
    }
    if (!Array.isArray(poseOrder) || poseOrder.length !== 3) return POSE_STEPS;
    const normalized = poseOrder.map((p) => String(p || '').trim().toLowerCase());
    const expected = new Set(['front', 'left', 'right']);
    if (normalized.some((p) => !expected.has(p))) return POSE_STEPS;
    if (new Set(normalized).size !== 3) return POSE_STEPS;
    const byKey = Object.fromEntries(POSE_STEPS.map((step) => [step.key, step]));
    return normalized.map((key) => byKey[key]).filter(Boolean);
  }, [poseOrder, variant]);

  const isLoginVariant = variant === 'login';
  const holdMs = isLoginVariant ? AUTO_CAPTURE_HOLD_LOGIN_MS : AUTO_CAPTURE_HOLD_MS;
  const fallbackDelayMs = isLoginVariant ? MANUAL_FALLBACK_DELAY_LOGIN_MS : MANUAL_FALLBACK_DELAY_MS;

  const currentStep = orderedSteps[activeStepIndex];
  // Login: immediately show green once the camera has video (cameraLiveRef tracked via state)
  // For enrollment: use backend analysis guide_color
  const [cameraIsLive, setCameraIsLive] = useState(false);
  const guideColor = isLoginVariant
    ? (cameraIsLive ? (analysis?.guide_color || 'green') : 'red')
    : (analysis?.guide_color || 'red');
  const palette = GUIDE_COLORS[guideColor] || GUIDE_COLORS.red;

  const resetFlow = () => {
    captureRequestInFlightRef.current = false;
    autoCaptureLockRef.current = false;
    stepStartedAtRef.current = Date.now();
    readySinceRef.current = null;
    lastReadyAtRef.current = null;
    // Cancel any login timer
    if (loginTimerRef.current) {
      window.clearInterval(loginTimerRef.current);
      loginTimerRef.current = null;
    }
    cameraLiveRef.current = false;
    setCameraIsLive(false);
    setCapturedShots({});
    setActiveStepIndex(0);
    setCameraError('');
    setAnalysis(null);
    setCaptureMessage('');
    setAutoCaptureProgress(0);
    setAutoCaptureRemainingMs(holdMs);
    // Login: show manual button immediately
    setShowManualFallback(isLoginVariant);
    setIsManualCaptureLoading(false);
  };

  const stopCamera = () => {
    if (pollingIntervalRef.current) {
      window.clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }

    if (videoRef.current?.srcObject) {
      videoRef.current.srcObject.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
  };

  const waitForVideoPlaying = async (videoEl, timeoutMs = 6000) => {
    if (!videoEl) {
      throw new Error('Video element not available');
    }

    // If already playing with dimensions, treat as ready.
    if (videoEl.readyState >= 2 && videoEl.videoWidth > 0 && videoEl.videoHeight > 0 && !videoEl.paused) {
      return;
    }

    await new Promise((resolve, reject) => {
      let done = false;
      const timeout = window.setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        const err = new Error('Timeout starting video source');
        err.name = 'AbortError';
        reject(err);
      }, timeoutMs);

      const cleanup = () => {
        window.clearTimeout(timeout);
        videoEl.removeEventListener('loadeddata', onReady);
        videoEl.removeEventListener('playing', onReady);
      };

      const onReady = () => {
        if (done) return;
        if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
          done = true;
          cleanup();
          resolve();
        }
      };

      videoEl.addEventListener('loadeddata', onReady, { once: false });
      videoEl.addEventListener('playing', onReady, { once: false });
    });
  };

  const startCamera = async () => {
    setIsCameraStarting(true);
    try {
      // Defensive: if an old stream is still attached, stop it before starting a new one.
      if (videoRef.current?.srcObject) {
        try {
          videoRef.current.srcObject.getTracks().forEach((track) => track.stop());
        } catch {
          // ignore
        }
        videoRef.current.srcObject = null;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 960, min: 640 },
          height: { ideal: 540, min: 360 },
          frameRate: { ideal: 24, max: 30 },
          facingMode: 'user',
        },
        audio: false,
      });

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // Some browsers need a short tick after srcObject assignment.
        await new Promise((resolve) => window.setTimeout(resolve, 0));

        // Try to start playback; AbortError can happen if element is not ready yet.
        try {
          await videoRef.current.play();
        } catch (playErr) {
          // Retry once after a short delay.
          const name = playErr?.name || '';
          if (name === 'AbortError' || name === 'NotAllowedError') {
            await new Promise((resolve) => window.setTimeout(resolve, 250));
            await videoRef.current.play();
          } else {
            throw playErr;
          }
        }

        await waitForVideoPlaying(videoRef.current, 6500);
      }
      setCameraError('');
      stepStartedAtRef.current = Date.now();
    } catch (error) {
      console.error('Guided enrollment camera error:', error);
      const msg = (error?.message || '').toLowerCase();
      if (error?.name === 'AbortError' || msg.includes('timeout')) {
        setCameraError('Camera started but video did not begin playing in time. Please close other camera apps and retry.');
      } else if (error?.name === 'NotAllowedError') {
        setCameraError('Camera permission denied. Please allow camera access and retry.');
      } else if (error?.name === 'NotFoundError') {
        setCameraError('No camera device found. Please connect a camera and retry.');
      } else {
        setCameraError('Unable to access the camera. Please allow camera permission and try again.');
      }
    } finally {
      setIsCameraStarting(false);
    }
  };

  const finishStepCapture = async (snapshot, result, trigger) => {
    if (!currentStep) {
      return;
    }

    autoCaptureLockRef.current = true;
    readySinceRef.current = null;
    lastReadyAtRef.current = null;
    // Cancel any in-progress login countdown
    if (loginTimerRef.current) {
      window.clearInterval(loginTimerRef.current);
      loginTimerRef.current = null;
    }
    setAutoCaptureProgress(0);
    setAutoCaptureRemainingMs(holdMs);
    // Login variant: manual button always visible
    setShowManualFallback(isLoginVariant);

    const nextShots = {
      ...capturedShots,
      [currentStep.key]: {
        blob: snapshot.blob,
        previewUrl: snapshot.previewUrl,
        analysis: result,
        trigger,
      },
    };

    setCapturedShots(nextShots);
    setCaptureMessage(`${currentStep.label} photo captured successfully.`);

    if (activeStepIndex >= orderedSteps.length - 1) {
      stopCamera();
      window.setTimeout(() => {
        onComplete(nextShots);
      }, 350);
      return;
    }

    window.setTimeout(() => {
      autoCaptureLockRef.current = false;
      stepStartedAtRef.current = Date.now();
      readySinceRef.current = null;
      lastReadyAtRef.current = null;
      setAnalysis(null);
      setCaptureMessage('');
      setAutoCaptureRemainingMs(holdMs);
      setShowManualFallback(isLoginVariant); // login keeps manual button up
      setActiveStepIndex((current) => current + 1);
    }, 650);
  };

  const normalizeSideStepAnalysis = (result) => {
    if (!currentStep || !result) {
      return result;
    }

    if (currentStep.key === 'front') {
      return result;
    }

    const currentSideSign = getYawSideSign(result);
    if (currentSideSign === 0) {
      return {
        ...result,
        ready_to_capture: false,
        guide_color: 'yellow',
        instruction: currentStep.key === 'left'
          ? 'Turn a little to either side.'
          : 'Turn to the opposite side from your first side photo.',
      };
    }

    if (currentStep.key === 'right') {
      const previousSideAnalysis = capturedShots.left?.analysis;
      const previousSideSign = getYawSideSign(previousSideAnalysis);
      if (previousSideSign !== 0 && previousSideSign === currentSideSign) {
        return {
          ...result,
          ready_to_capture: false,
          guide_color: 'red',
          instruction: 'Turn to the opposite side from your first side photo.',
        };
      }
    }

    return {
      ...result,
      instruction: currentStep.key === 'left'
        ? 'Hold that side angle steady.'
        : 'Hold the opposite side angle steady.',
    };
  };

  const analyzeSnapshot = async (snapshot, { allowAutoCapture }) => {
    if (!currentStep) {
      return null;
    }

    const requirePoseMatch = variant === 'enrollment';
    const rawResult = await authService.analyzeEnrollmentFrame({
      image: snapshot.blob,
      targetPose: currentStep.key,
      requirePoseMatch,
    });
    // Login variant: skip the strict side-pose normalization (front-only anyway)
    const result = (variant === 'enrollment') ? normalizeSideStepAnalysis(rawResult) : rawResult;

    setAnalysis(result);
    setCameraError('');

    const elapsedMs = Date.now() - stepStartedAtRef.current;
    if (elapsedMs >= fallbackDelayMs) {
      setShowManualFallback(true);
    }

    const now = Date.now();
    if (result.ready_to_capture) {
      if (!readySinceRef.current) {
        readySinceRef.current = now;
      }
      lastReadyAtRef.current = now;

      const heldMs = now - readySinceRef.current;
      setAutoCaptureProgress(Math.min(1, heldMs / holdMs));
      setAutoCaptureRemainingMs(Math.max(0, holdMs - heldMs));

      if (allowAutoCapture && heldMs >= holdMs && !autoCaptureLockRef.current) {
        await finishStepCapture(snapshot, result, 'automatic');
      }
    } else if (
      readySinceRef.current
      && lastReadyAtRef.current
      && (now - lastReadyAtRef.current) <= AUTO_CAPTURE_GRACE_MS
    ) {
      const heldMs = Math.max(0, lastReadyAtRef.current - readySinceRef.current);
      setAutoCaptureProgress(Math.min(1, heldMs / holdMs));
      setAutoCaptureRemainingMs(Math.max(0, holdMs - heldMs));
    } else {
      readySinceRef.current = null;
      lastReadyAtRef.current = null;
      setAutoCaptureProgress(0);
      setAutoCaptureRemainingMs(holdMs);
    }

    return result;
  };

  const pollCurrentFrame = async () => {
    if (!isOpen || captureRequestInFlightRef.current || autoCaptureLockRef.current || !currentStep) {
      return;
    }

    if (!videoRef.current?.srcObject || !videoRef.current.videoWidth || !videoRef.current.videoHeight) {
      return;
    }

    captureRequestInFlightRef.current = true;
    try {
      const snapshot = await captureFrameFromVideo(videoRef.current);
      await analyzeSnapshot(snapshot, { allowAutoCapture: true });
    } catch (error) {
      console.error('Enrollment analysis polling failed:', error);
      setCameraError(error.message || 'Unable to analyze the live camera frame.');
    } finally {
      captureRequestInFlightRef.current = false;
    }
  };

  const handleManualCapture = async () => {
    if (!currentStep || !videoRef.current?.srcObject) {
      return;
    }

    setIsManualCaptureLoading(true);
    try {
      const snapshot = await captureFrameFromVideo(videoRef.current, { enforceQuality: isLoginVariant });

      // Login variant: skip backend analysis — just take the photo and submit
      if (isLoginVariant) {
        const syntheticResult = {
          ready_to_capture: true,
          guide_color: 'green',
          instruction: 'Captured.',
          issues: [],
        };
        await finishStepCapture(snapshot, syntheticResult, 'manual');
        return;
      }

      // Enrollment: run full analysis
      const result = await analyzeSnapshot(snapshot, { allowAutoCapture: false });
      if (!result?.ready_to_capture) {
        setCameraError(result?.instruction || 'That photo is not clear enough. Adjust and try again.');
        return;
      }
      await finishStepCapture(snapshot, result, 'manual');
    } catch (error) {
      console.error('Manual capture failed:', error);
      setCameraError(error.message || 'Unable to capture the current frame.');
    } finally {
      setIsManualCaptureLoading(false);
    }
  };

  const handleClose = () => {
    stopCamera();
    resetFlow();
    onClose();
  };

  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      return undefined;
    }

    resetFlow();
    void startCamera();

    return () => {
      stopCamera();
      if (loginTimerRef.current) {
        window.clearInterval(loginTimerRef.current);
        loginTimerRef.current = null;
      }
    };
  }, [isOpen]);

  // ── Login variant: lightweight local countdown (no backend API call) ──────────
  // Once the camera has live video frames, show green guide and count down holdMs.
  useEffect(() => {
    if (!isOpen || !isLoginVariant || cameraError || autoCaptureLockRef.current) {
      return undefined;
    }

    // Poll for camera becoming live (videoWidth > 0)
    const detectCameraLive = window.setInterval(() => {
      if (cameraLiveRef.current) {
        window.clearInterval(detectCameraLive);
        return;
      }
      if (
        videoRef.current?.srcObject
        && videoRef.current.videoWidth > 0
        && videoRef.current.videoHeight > 0
      ) {
        if (Date.now() - stepStartedAtRef.current < LOGIN_CAMERA_SETTLE_MS) {
          return;
        }
        cameraLiveRef.current = true;
        setCameraIsLive(true);
        // Synthesize a "green / ready" state so GuideLines turns green
        setAnalysis({
          ready_to_capture: true,
          guide_color: 'green',
          instruction: 'Look straight at the camera. Capturing automatically…',
          issues: [],
        });
        window.clearInterval(detectCameraLive);

        // Start the hold countdown
        const startedAt = Date.now();
        if (loginTimerRef.current) window.clearInterval(loginTimerRef.current);
        loginTimerRef.current = window.setInterval(async () => {
          if (autoCaptureLockRef.current) {
            window.clearInterval(loginTimerRef.current);
            loginTimerRef.current = null;
            return;
          }
          const elapsed = Date.now() - startedAt;
          const progress = Math.min(1, elapsed / holdMs);
          setAutoCaptureProgress(progress);
          setAutoCaptureRemainingMs(Math.max(0, holdMs - elapsed));

          if (elapsed >= holdMs) {
            window.clearInterval(loginTimerRef.current);
            loginTimerRef.current = null;
            if (autoCaptureLockRef.current || captureRequestInFlightRef.current) return;
            if (!videoRef.current?.srcObject || !videoRef.current.videoWidth) return;
            captureRequestInFlightRef.current = true;
            try {
              const snapshot = await captureFrameFromVideo(videoRef.current, { enforceQuality: true });
              const syntheticResult = {
                ready_to_capture: true,
                guide_color: 'green',
                instruction: 'Captured.',
                issues: [],
              };
              await finishStepCapture(snapshot, syntheticResult, 'automatic');
            } catch (err) {
              console.error('Login auto-capture failed:', err);
              setCameraError(err.message || 'Failed to capture. Try the manual button.');
            } finally {
              captureRequestInFlightRef.current = false;
            }
          }
        }, 80); // update every 80ms for smooth progress bar
      }
    }, 200);

    return () => {
      window.clearInterval(detectCameraLive);
      if (loginTimerRef.current) {
        window.clearInterval(loginTimerRef.current);
        loginTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isLoginVariant, cameraError, activeStepIndex]);

  // ── Enrollment variant: backend-driven frame polling ───────────────────────
  useEffect(() => {
    if (!isOpen || isLoginVariant || cameraError || !currentStep) {
      return undefined;
    }

    if (pollingIntervalRef.current) {
      window.clearInterval(pollingIntervalRef.current);
    }

    pollingIntervalRef.current = window.setInterval(() => {
      void pollCurrentFrame();
    }, ANALYSIS_INTERVAL_MS);

    return () => {
      if (pollingIntervalRef.current) {
        window.clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [isOpen, isLoginVariant, activeStepIndex, cameraError, currentStep]);

  const completionProgress = useMemo(() => {
    const completed = Object.keys(capturedShots).length;
    const total = orderedSteps.length;
    return `${completed}/${total} complete`;
  }, [capturedShots, orderedSteps]);

  const autoCaptureIsActive = Boolean(analysis?.ready_to_capture || autoCaptureProgress > 0);
  const autoCaptureSecondsLeft = Math.max(1, Math.ceil(autoCaptureRemainingMs / 1000));
  const showLoginCountdownOverlay = isLoginVariant && autoCaptureIsActive && !isManualCaptureLoading;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} panelClassName="max-w-5xl">
      <div className="flex flex-col bg-white">
        <div className="border-b border-slate-100 bg-slate-50 px-6 py-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
                <ScanFace className="h-4 w-4" />
                {badgeLabel}
              </div>
              <h3 className="mt-3 text-2xl font-bold text-slate-900">{title}</h3>
              <p className="mt-1 max-w-2xl text-sm text-slate-500">
                {description}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-right shadow-sm">
              <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Progress</span>
              <strong className="mt-1 block text-lg text-slate-900">{completionProgress}</strong>
            </div>
          </div>
        </div>

        <div className="grid gap-6 bg-white p-6 lg:grid-cols-[1.45fr_0.55fr]">
          <div className="rounded-[28px] border border-slate-200 bg-slate-950 p-4 shadow-[0_28px_70px_rgba(15,23,42,0.28)]">
            <div className="mb-4 rounded-[24px] border border-white/10 bg-white/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 text-white">
                    <PoseIcon poseKey={currentStep?.key} className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
                      Step {activeStepIndex + 1} of {orderedSteps.length}
                    </p>
                    <h4 className="mt-1 text-xl font-semibold text-white">{currentStep?.title}</h4>
                    <p className="mt-1 text-sm text-slate-300">{currentStep?.helper}</p>
                  </div>
                </div>
                <div className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${palette.chip}`}>
                  {analysis?.ready_to_capture ? 'Aligned' : guideColor === 'yellow' ? 'Almost There' : 'Adjust'}
                </div>
              </div>

              <div className="mt-4 grid gap-2 md:grid-cols-3">
                {orderedSteps.map((step, index) => {
                  const isActive = index === activeStepIndex;
                  const isDone = Boolean(capturedShots[step.key]);
                  return (
                    <div
                      key={step.key}
                      className={`rounded-2xl border px-3 py-3 ${
                        isDone
                          ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100'
                          : isActive
                            ? 'border-white/20 bg-white/10 text-white'
                            : 'border-white/10 bg-white/[0.04] text-slate-400'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <PoseIcon poseKey={step.key} className="h-4 w-4" />
                        <span className="text-sm font-semibold">{step.label}</span>
                      </div>
                      <p className="mt-1 text-xs">
                        {isDone ? 'Captured' : isActive ? 'Current step' : 'Waiting'}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="relative overflow-hidden rounded-[26px] border border-white/10 bg-slate-900">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="h-[420px] w-full -scale-x-100 object-cover"
              />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(15,23,42,0.12),rgba(15,23,42,0.6))]" />
              <GuideLines poseKey={currentStep?.key} colorKey={guideColor} />

              {showLoginCountdownOverlay && (
                <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-3xl border border-emerald-300/40 bg-slate-950/80 px-7 py-5 text-center shadow-[0_12px_40px_rgba(16,185,129,0.28)] backdrop-blur">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-200/90">Capturing In</p>
                  <div className="mt-1 text-5xl font-black leading-none text-emerald-300">{autoCaptureSecondsLeft}</div>
                  <p className="mt-2 text-xs font-medium text-emerald-100/80">Hold still and keep your face centered</p>
                </div>
              )}

              <div className="absolute left-5 top-5 rounded-full border border-white/10 bg-slate-950/60 px-4 py-2 text-sm font-semibold text-white backdrop-blur">
                {currentStep?.label} pose
              </div>

              <div className="absolute right-5 top-5 rounded-[22px] border border-white/10 bg-slate-950/70 px-4 py-3 text-right text-white backdrop-blur">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Auto Capture</p>
                <div className="mt-1 text-3xl font-bold leading-none">
                  {autoCaptureIsActive ? autoCaptureSecondsLeft : 3}
                </div>
                <p className="mt-1 text-xs text-slate-300">
                  {autoCaptureIsActive ? 'Hold still' : 'Seconds to hold'}
                </p>
              </div>

              <div className="absolute inset-x-5 bottom-5 rounded-3xl border border-white/10 bg-slate-950/74 p-4 backdrop-blur-xl">
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border ${palette.chip}`}>
                    {analysis?.ready_to_capture ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-semibold ${palette.text}`}>
                      {analysis?.instruction || 'Analyzing your live face position...'}
                    </p>
                    <div
                      className={`mt-3 flex items-center justify-between rounded-2xl border px-3 py-2 text-sm ${
                        autoCaptureIsActive
                          ? palette.chip
                          : 'border-white/10 bg-white/5 text-slate-300'
                      }`}
                    >
                      <span className="font-medium">
                        {autoCaptureIsActive ? 'Hold still for auto capture' : 'Fit your full face inside the frame'}
                      </span>
                      <span className="text-base font-bold">
                        {autoCaptureIsActive ? `${autoCaptureSecondsLeft}s` : `${Math.ceil(holdMs / 1000)}s hold`}
                      </span>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${palette.progress}`}
                        style={{ width: `${Math.round(autoCaptureProgress * 100)}%` }}
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-300">
                      <span>
                        {autoCaptureIsActive
                          ? `Capturing ${currentStep?.label.toLowerCase()} pose automatically after the ${autoCaptureSecondsLeft}s hold`
                          : `Auto capture waiting for a clear ${currentStep?.label.toLowerCase()} pose`}
                      </span>
                      {captureMessage && <span className="text-emerald-300">{captureMessage}</span>}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
                <Dot className="h-5 w-5 text-emerald-300" />
                <span>
                  {showManualFallback
                    ? 'You can capture manually at any time now.'
                    : 'Auto capture becomes active when your full face fits inside the frame.'}
                </span>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => {
                    stopCamera();
                    resetFlow();
                    void startCamera();
                  }}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:border-slate-300 hover:text-slate-900"
                >
                  <RefreshCw className="h-4 w-4" />
                  Start Over
                </button>
                <button
                  type="button"
                  onClick={handleManualCapture}
                  disabled={isManualCaptureLoading || isCameraStarting}
                  className="inline-flex items-center gap-2 rounded-full bg-emerald-500 px-5 py-2 text-sm font-semibold text-white shadow-lg transition-all hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Camera className="h-4 w-4" />
                  {isManualCaptureLoading ? 'Capturing...' : 'Capture Now'}
                </button>
              </div>
            </div>

            {cameraError && (
              <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                {cameraError}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-4">
            <div className="rounded-[28px] border border-slate-200 bg-slate-50 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Quick Help</p>
              <ul className="mt-4 space-y-3 text-sm text-slate-600">
                {isLoginVariant ? (
                  <>
                    <li>Face the camera directly — center your face in the oval frame.</li>
                    <li>The photo captures <strong>automatically</strong> after a short stability hold.</li>
                    <li>Or press <strong>Capture Now</strong> at any time to take the photo manually.</li>
                    <li>Make sure your face is well-lit and not obscured by sunglasses or masks.</li>
                    <li>This photo is used to verify you are the registered student during the exam.</li>
                  </>
                ) : (
                  <>
                    <li>Use your normal laptop position and keep your full face inside the frame.</li>
                    <li>For left and right photos, only turn a little, not full side profile.</li>
                    <li>When the guide looks good, hold still for 1.5 seconds or press Capture Now.</li>
                    <li>You do not need a perfectly straight head. Natural sitting position is okay.</li>
                    <li>Good light on your face helps the photo pass quickly.</li>
                  </>
                )}
              </ul>
            </div>

            <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">Captured References</p>
              <div className="mt-4 grid gap-3">
                {orderedSteps.map((step) => {
                  const shot = capturedShots[step.key];
                  return (
                    <div
                      key={step.key}
                      className={`overflow-hidden rounded-2xl border ${
                        shot ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between border-b border-black/5 px-4 py-3">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{step.label}</p>
                          <p className="text-xs text-slate-500">{step.title}</p>
                        </div>
                        {shot ? (
                          <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                            ready
                          </span>
                        ) : (
                          <span className="rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-500">
                            pending
                          </span>
                        )}
                      </div>
                      <div className="p-3">
                        {shot ? (
                          <img
                            src={shot.previewUrl}
                            alt={`${step.label} reference`}
                            className="h-28 w-full rounded-xl object-cover"
                          />
                        ) : (
                          <div className="flex h-28 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white text-sm text-slate-400">
                            Waiting for {step.label.toLowerCase()} capture
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default GuidedFaceEnrollmentModal;
