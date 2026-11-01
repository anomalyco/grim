//! Opus at 48 kHz mono through libopus (linked statically, `build.rs`): 20 ms frames for the microphone, and the
//! voice's packets decoded for the speaker.

use std::ffi::c_int;

#[repr(C)]
struct OpusEncoder {
    _p: [u8; 0],
}
#[repr(C)]
struct OpusDecoder {
    _p: [u8; 0],
}

unsafe extern "C" {
    fn opus_encoder_create(fs: i32, channels: c_int, application: c_int, error: *mut c_int) -> *mut OpusEncoder;
    fn opus_encode_float(st: *mut OpusEncoder, pcm: *const f32, frame_size: c_int, data: *mut u8, max_data_bytes: i32) -> i32;
    fn opus_encoder_ctl(st: *mut OpusEncoder, request: c_int, ...) -> c_int;
    fn opus_encoder_destroy(st: *mut OpusEncoder);
    fn opus_decoder_create(fs: i32, channels: c_int, error: *mut c_int) -> *mut OpusDecoder;
    fn opus_decode_float(st: *mut OpusDecoder, data: *const u8, len: i32, pcm: *mut f32, frame_size: c_int, decode_fec: c_int) -> c_int;
    fn opus_decoder_destroy(st: *mut OpusDecoder);
}

pub const RATE: u32 = 48_000;
/// 20 ms.
pub const FRAME: usize = 960;
const APPLICATION_VOIP: c_int = 2048;
const SET_BITRATE: c_int = 4002;
const SET_INBAND_FEC: c_int = 4012;
const SET_PACKET_LOSS_PERC: c_int = 4014;

pub struct Encoder(*mut OpusEncoder);
// SAFETY: the encoder is plain memory, used from one thread at a time.
unsafe impl Send for Encoder {}

impl Encoder {
    pub fn new() -> Result<Encoder, String> {
        let mut err = 0;
        // SAFETY: valid arguments; the result is checked.
        let st = unsafe { opus_encoder_create(RATE as i32, 1, APPLICATION_VOIP, &mut err) };
        if st.is_null() || err != 0 {
            return Err(format!("Opus encoder error {err}"));
        }
        // SAFETY: a live encoder and the documented integer requests.
        unsafe {
            opus_encoder_ctl(st, SET_BITRATE, 32_000 as c_int);
            opus_encoder_ctl(st, SET_INBAND_FEC, 1 as c_int);
            opus_encoder_ctl(st, SET_PACKET_LOSS_PERC, 5 as c_int);
        }
        Ok(Encoder(st))
    }

    /// One 20 ms frame (`FRAME` samples) to a packet.
    pub fn encode(&mut self, pcm: &[f32]) -> Result<Vec<u8>, String> {
        assert_eq!(pcm.len(), FRAME);
        let mut out = vec![0u8; 1500];
        // SAFETY: `pcm` holds a whole frame and `out` its stated size.
        let n = unsafe { opus_encode_float(self.0, pcm.as_ptr(), FRAME as c_int, out.as_mut_ptr(), out.len() as i32) };
        if n < 0 {
            return Err(format!("Opus encode error {n}"));
        }
        out.truncate(n as usize);
        Ok(out)
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        // SAFETY: created by `opus_encoder_create`, destroyed once.
        unsafe { opus_encoder_destroy(self.0) }
    }
}

pub struct Decoder(*mut OpusDecoder, Vec<f32>);
// SAFETY: as the encoder's.
unsafe impl Send for Decoder {}

impl Decoder {
    pub fn new() -> Result<Decoder, String> {
        let mut err = 0;
        // SAFETY: valid arguments; the result is checked.
        let st = unsafe { opus_decoder_create(RATE as i32, 1, &mut err) };
        if st.is_null() || err != 0 {
            return Err(format!("Opus decoder error {err}"));
        }
        Ok(Decoder(st, vec![0.0; 5760]))
    }

    /// A packet to samples; `None` for a lost one (concealed: one frame).
    pub fn decode(&mut self, packet: Option<&[u8]>) -> &[f32] {
        let (ptr, len, max) = match packet {
            Some(p) => (p.as_ptr(), p.len() as i32, self.1.len()),
            None => (std::ptr::null(), 0, FRAME),
        };
        // SAFETY: the buffer holds `max` samples (120 ms at most), the packet its length.
        let n = unsafe { opus_decode_float(self.0, ptr, len, self.1.as_mut_ptr(), max as c_int, 0) };
        &self.1[..n.max(0) as usize]
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        // SAFETY: created by `opus_decoder_create`, destroyed once.
        unsafe { opus_decoder_destroy(self.0) }
    }
}
