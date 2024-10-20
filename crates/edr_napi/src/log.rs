use std::mem;

use napi::{bindgen_prelude::Buffer, Env, JsBuffer, JsBufferValue};
use napi_derive::napi;

/// Ethereum execution log.
#[napi(object)]
pub struct ExecutionLog {
    pub address: Buffer,
    pub topics: Vec<Buffer>,
    pub data: JsBuffer,
}

impl ExecutionLog {
    pub fn new(env: &Env, log: &edr_evm::Log) -> napi::Result<Self> {
        let topics = log
            .topics
            .iter()
            .map(|topic| Buffer::from(topic.as_slice()))
            .collect();

        let data = log.data.clone();
        let data = unsafe {
            env.create_buffer_with_borrowed_data(
                data.as_ptr(),
                data.len(),
                data,
                |data: edr_eth::Bytes, _env| {
                    mem::drop(data);
                },
            )
        }
        .map(JsBufferValue::into_raw)?;

        Ok(Self {
            address: Buffer::from(log.address.as_slice()),
            topics,
            data,
        })
    }
}
