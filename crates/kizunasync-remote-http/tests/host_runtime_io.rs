//! The host runtime must be able to drive the real reqwest transport: the FFI
//! `http` feature runs every request inside `kizunasync_engine::current_thread_runtime()`.
// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use kizunasync_remote_http::{HttpMethod, HttpRequest, HttpTransport, ReqwestTransport};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

/// Drains `stream` until the request headers end, or the peer closes first.
fn read_until_headers_end(stream: &mut TcpStream) {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 512];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buffer.extend_from_slice(&chunk[..n]);
                if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
        }
    }
}

#[test]
fn host_runtime_drives_the_reqwest_transport() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback listener");
    let port = listener
        .local_addr()
        .expect("listener local address")
        .port();

    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept one connection");
        read_until_headers_end(&mut stream);
        stream
            .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .expect("write the response");
        stream.flush().expect("flush the response");
    });

    let runtime =
        kizunasync_engine::current_thread_runtime().expect("host runtime with IO enabled");
    let transport = ReqwestTransport::new().expect("build the production transport");
    let result = runtime.block_on(transport.execute(HttpRequest {
        method: HttpMethod::Get,
        url: format!("http://127.0.0.1:{port}/"),
        headers: Vec::new(),
        body: Vec::new(),
        timeout: None,
    }));

    let response = result.expect("the host runtime must drive the reqwest transport's IO");
    assert_eq!(response.status, 204);

    server.join().expect("join the server thread");
}
