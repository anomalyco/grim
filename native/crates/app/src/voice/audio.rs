//! The microphone and the speaker: one AVAudioEngine with voice processing on its input node (Apple's echo
//! cancellation), a tap on the input for the microphone and an AVAudioSourceNode on the same engine playing the voice,
//! so the canceller hears what plays. Both meet the session thread in `session::Pipes`.

use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::mpsc::channel;
use std::time::Duration;

use block2::RcBlock;
use objc2::AnyThread;
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use objc2_avf_audio::{AVAudioEngine, AVAudioFormat, AVAudioPCMBuffer, AVAudioSourceNode, AVAudioTime};
use objc2_core_audio_types::{AudioBufferList, AudioTimeStamp};

use super::session::Pipes;

const DENIED: &str = "Grim can't use the microphone. Turn it on in System Settings › Privacy & Security › Microphone, then try again.";

/// Ask for the microphone the first time (the system's prompt); an error when it's off.
pub fn mic_permission() -> Result<(), String> {
    // SAFETY: AVFoundation's constant, valid for the process's life.
    let ty = unsafe { AVMediaTypeAudio }.ok_or("No audio capture on this Mac.")?;
    // SAFETY: a valid media type.
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(ty) };
    if status == AVAuthorizationStatus::Authorized {
        return Ok(());
    }
    if status != AVAuthorizationStatus::NotDetermined {
        return Err(DENIED.into());
    }
    let (tx, rx) = channel();
    let done = RcBlock::new(move |ok: Bool| {
        let _ = tx.send(ok.as_bool());
    });
    // SAFETY: a valid media type and a block called once on some queue.
    unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(ty, &done) };
    match rx.recv_timeout(Duration::from_secs(300)) {
        Ok(true) => Ok(()),
        _ => Err(DENIED.into()),
    }
}

pub struct Engine {
    engine: Retained<AVAudioEngine>,
    rate: f64,
    channels: u32,
    _tap: RcBlock<dyn Fn(NonNull<AVAudioPCMBuffer>, NonNull<AVAudioTime>)>,
    _render: RcBlock<dyn Fn(NonNull<Bool>, NonNull<AudioTimeStamp>, u32, NonNull<AudioBufferList>) -> i32>,
    _src: Retained<AVAudioSourceNode>,
}

impl Engine {
    pub fn start(pipes: Arc<Pipes>) -> Result<Engine, String> {
        // SAFETY: AVAudioEngine's documented use: configured while stopped, blocks kept alive by `Engine`.
        unsafe {
            let engine = AVAudioEngine::new();
            let input = engine.inputNode();
            input.setVoiceProcessingEnabled_error(true).map_err(|e| format!("Voice processing: {}", e.localizedDescription()))?;
            let in_fmt = input.outputFormatForBus(0);
            let rate = in_fmt.sampleRate();
            let channels = in_fmt.channelCount();
            if rate <= 0.0 || channels == 0 {
                return Err("No microphone input.".into());
            }

            // the microphone: channel 0 of the processed input
            let mic = pipes.clone();
            let tap = RcBlock::new(move |buf: NonNull<AVAudioPCMBuffer>, _t: NonNull<AVAudioTime>| {
                let buf = buf.as_ref();
                let n = buf.frameLength() as usize;
                let data = buf.floatChannelData();
                if data.is_null() || n == 0 {
                    return;
                }
                let ch0 = std::slice::from_raw_parts((*data).as_ptr(), n);
                mic.push_mic(ch0, rate);
            });
            input.installTapOnBus_bufferSize_format_block(0, 960, None, RcBlock::as_ptr(&tap));

            // the speaker: 48 kHz mono from the session, through the main mixer
            let fmt = AVAudioFormat::initStandardFormatWithSampleRate_channels(AVAudioFormat::alloc(), 48_000.0, 1).ok_or("No audio format.")?;
            let spk = pipes.clone();
            let render = RcBlock::new(move |_silence: NonNull<Bool>, _ts: NonNull<AudioTimeStamp>, frames: u32, abl: NonNull<AudioBufferList>| -> i32 {
                let abl = abl.as_ptr();
                let count = (*abl).mNumberBuffers as usize;
                let bufs = std::slice::from_raw_parts_mut((*abl).mBuffers.as_mut_ptr(), count);
                let mut first: Option<&[f32]> = None;
                for b in bufs.iter_mut() {
                    if b.mData.is_null() {
                        continue;
                    }
                    let n = (frames as usize).min(b.mDataByteSize as usize / 4);
                    let out = std::slice::from_raw_parts_mut(b.mData as *mut f32, n);
                    match first {
                        None => {
                            spk.pull_spk(out);
                            first = Some(std::slice::from_raw_parts(out.as_ptr(), n));
                        }
                        Some(f) => out.copy_from_slice(&f[..n.min(f.len())]),
                    }
                }
                0
            });
            let src = AVAudioSourceNode::initWithFormat_renderBlock(AVAudioSourceNode::alloc(), &fmt, RcBlock::as_ptr(&render));
            engine.attachNode(&src);
            engine.connect_to_format(&src, &engine.mainMixerNode(), Some(&fmt));
            engine.prepare();
            engine.startAndReturnError().map_err(|e| format!("Audio: {}", e.localizedDescription()))?;
            Ok(Engine { engine, rate, channels, _tap: tap, _render: render, _src: src })
        }
    }

    pub fn describe(&self) -> String {
        format!("voice processing on, input {} Hz × {}", self.rate, self.channels)
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // SAFETY: the engine and its input node are alive; stopping is allowed from any thread.
        unsafe {
            self.engine.inputNode().removeTapOnBus(0);
            self.engine.stop();
        }
    }
}
