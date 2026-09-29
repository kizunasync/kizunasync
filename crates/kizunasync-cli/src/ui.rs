//! Output channel.
//!
//! Byte-stability contract: [`Ui::write_stdout`] is the only method that
//! touches stdout and it never themes its input, so callers own the exact bytes
//! (JSON/JSONL/SQL). Everything else is human status on stderr, themed when the
//! session is coloured.
//!
//! Tests drive commands through [`Ui::capture`], so no command needs a process.

use std::io::{IsTerminal, Write};
use std::sync::{Arc, Mutex};

/// Whether themed output is enabled for this session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorMode {
    /// ANSI escapes are written.
    On,
    /// Plain text only.
    Off,
}

/// The CLI's two output streams plus its colour decision.
pub struct Ui {
    out: Box<dyn Write + Send>,
    err: Box<dyn Write + Send>,
    color: ColorMode,
}

/// The buffers a captured [`Ui`] writes into.
#[derive(Clone)]
pub struct Capture {
    stdout: Arc<Mutex<Vec<u8>>>,
    stderr: Arc<Mutex<Vec<u8>>>,
}

impl Capture {
    /// Everything written to stdout so far, lossily decoded.
    #[must_use]
    pub fn stdout(&self) -> String {
        Self::read(&self.stdout)
    }

    /// Everything written to stderr so far, lossily decoded.
    #[must_use]
    pub fn stderr(&self) -> String {
        Self::read(&self.stderr)
    }

    fn read(buffer: &Arc<Mutex<Vec<u8>>>) -> String {
        let bytes = buffer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

/// A `Write` handle onto a shared buffer, so a captured `Ui` and its assertions
/// can hold the same bytes.
struct SharedBuffer(Arc<Mutex<Vec<u8>>>);

impl Write for SharedBuffer {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self.0.lock() {
            Ok(mut bytes) => {
                bytes.extend_from_slice(buf);
                Ok(buf.len())
            }
            Err(_) => Err(std::io::Error::other("captured output buffer was poisoned")),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Ui {
    /// The real process streams, with colour autodetected from stdout.
    #[must_use]
    pub fn stdio() -> Self {
        let color = if std::io::stdout().is_terminal() {
            ColorMode::On
        } else {
            ColorMode::Off
        };

        Self {
            out: Box::new(std::io::stdout()),
            err: Box::new(std::io::stderr()),
            color,
        }
    }

    /// A `Ui` writing into in-memory buffers, for tests.
    #[must_use]
    pub fn capture() -> (Self, Capture) {
        let capture = Capture {
            stdout: Arc::new(Mutex::new(Vec::new())),
            stderr: Arc::new(Mutex::new(Vec::new())),
        };
        let ui = Self {
            out: Box::new(SharedBuffer(Arc::clone(&capture.stdout))),
            err: Box::new(SharedBuffer(Arc::clone(&capture.stderr))),
            color: ColorMode::Off,
        };

        (ui, capture)
    }

    /// Force colour off: how `--ci`, `--json`, `--no-color`, and `NO_COLOR` are
    /// honoured, each stage short-circuiting the next.
    pub const fn set_color(&mut self, color: ColorMode) {
        self.color = color;
    }

    /// The structured payload: exact bytes, never themed, never line-terminated
    /// on the caller's behalf.
    pub fn write_stdout(&mut self, text: &str) {
        // CLI exception: a write/flush failure here (typically a closed pipe, as in
        // `| head`) ends the process through the eventual non-zero exit code, not
        // through a second error the caller would have to handle.
        let _ = self.out.write_all(text.as_bytes());
        let _ = self.out.flush();
    }

    /// One line of human status on stderr.
    pub fn log(&mut self, text: &str) {
        self.write_err_line(text);
    }

    /// A section heading.
    pub fn heading(&mut self, text: &str) {
        let line = self.paint(text, BOLD);
        self.write_err_line(&line);
    }

    /// A passing check or a completed step.
    pub fn success(&mut self, text: &str) {
        let line = self.paint(&format!("✔ {text}"), GREEN);
        self.write_err_line(&line);
    }

    /// A non-fatal caution.
    pub fn warn(&mut self, text: &str) {
        let line = self.paint(&format!("⚠ {text}"), YELLOW);
        self.write_err_line(&line);
    }

    /// A failing check or a refusal.
    pub fn error(&mut self, text: &str) {
        let line = self.paint(&format!("✗ {text}"), RED);
        self.write_err_line(&line);
    }

    fn write_err_line(&mut self, text: &str) {
        // A live wizard draws status on the same left bar as the questions, and
        // counts those rows so Backspace can erase the step that printed them.
        if crate::wizard_theme::capture_log(text) {
            return;
        }
        let _ = self.err.write_all(text.as_bytes());
        let _ = self.err.write_all(b"\n");
        let _ = self.err.flush();
    }

    fn paint(&self, text: &str, code: &str) -> String {
        match self.color {
            ColorMode::On => format!("\u{1b}[{code}m{text}\u{1b}[0m"),
            ColorMode::Off => text.to_owned(),
        }
    }
}

const BOLD: &str = "1";
const GREEN: &str = "32";
const YELLOW: &str = "33";
const RED: &str = "31";

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn stdout_is_never_themed_and_never_line_terminated() {
        let (mut ui, capture) = Ui::capture();
        ui.set_color(ColorMode::On);
        ui.write_stdout("{\"a\":1}");

        assert_eq!(capture.stdout(), "{\"a\":1}");
        assert_eq!(capture.stderr(), "");
    }

    #[test]
    fn human_status_goes_to_stderr_one_line_at_a_time() {
        let (mut ui, capture) = Ui::capture();
        ui.log("plain");
        ui.success("ok");
        ui.error("bad");

        assert_eq!(capture.stderr(), "plain\n✔ ok\n✗ bad\n");
        assert_eq!(capture.stdout(), "");
    }

    #[test]
    fn colour_on_wraps_status_lines_and_colour_off_does_not() {
        let (mut ui, capture) = Ui::capture();
        ui.set_color(ColorMode::On);
        ui.success("ok");
        ui.set_color(ColorMode::Off);
        ui.success("ok");

        assert_eq!(capture.stderr(), "\u{1b}[32m✔ ok\u{1b}[0m\n✔ ok\n");
    }
}
