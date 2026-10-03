//! Ctrl+C.
//!
//! A question holds the keys while it is drawn and while it waits
//! (`KeysAtPrompt`), so the terminal hands it Ctrl+C as a key: the wizard
//! cancels, closes its chrome, and exits `0`. Anywhere else the terminal sends
//! SIGINT. When SIGINT lands during a Postgres statement (`cancellable`), the
//! handler sends the server a cancel request for that statement and waits for
//! it to end, because a script that already reached the server keeps running
//! after the client is gone and commits on its own. A cancelled statement never
//! commits, and Postgres rolls back a transaction that never committed. The
//! handler then prints what happened to the transaction, puts the terminal
//! back in the mode the run started in, and exits `130`, the code a shell
//! reports for an interrupted command (@docs/cli/cli.md).
//!
//! When SIGINT lands while a `supabase db push` child runs (`supervised`), the
//! handler sends the child SIGINT, then SIGTERM if it is still running after
//! a short wait, and waits for it to exit. The run then reads the migration
//! history again, removes each file it wrote that the history does not record,
//! reports both lists, and exits `130` itself (`exit_interrupted`). The handler
//! ignores every later Ctrl+C while the run reports, and the history read gets
//! a bounded wait (`within`), so the report always ends.

use std::sync::mpsc;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// The exit code of a run Ctrl+C stopped outside a prompt.
pub const INTERRUPTED: i32 = 130;

const NOT_APPLIED: &str = "interrupted: the transaction in progress was not applied (Postgres rolls back a transaction that never committed).";

const MAY_HAVE_COMMITTED: &str = "interrupted: the server did not confirm that the statement in progress stopped, so its transaction may have committed. Run `kizunasync status` to see what the database holds.";

/// How long the cancel request gets to reach the server, and then the
/// cancelled statement to end.
const CANCEL_WAIT: Duration = Duration::from_secs(5);

/// How long a child gets to exit on SIGINT before it is sent SIGTERM.
const CHILD_GRACE: Duration = Duration::from_secs(3);

/// Sends the server a cancel request for the statement in flight.
pub(crate) type Cancel = Box<dyn FnOnce() + Send>;

/// The terminal mode the run started in, which every way out puts back.
static START: Mutex<Option<terminal::Saved>> = Mutex::new(None);

/// Answer SIGINT with [`INTERRUPTED`] for the rest of the process.
///
/// # Errors
/// Returns the handler library's own failure when a handler cannot be
/// installed.
pub fn install() -> Result<(), ctrlc::Error> {
    *START.lock().unwrap_or_else(PoisonError::into_inner) = terminal::Saved::of_stdin();
    ctrlc::set_handler(on_interrupt)
}

fn on_interrupt() {
    match STATEMENTS.stop(CANCEL_WAIT) {
        Stop::Line(line) => {
            let _ = console::Term::stderr().write_line(&format!("\n  {line}"));
            exit_interrupted();
        }
        // The run reports what the child left and exits on its own thread.
        Stop::Child(pid) => STATEMENTS.stop_child(pid, CHILD_GRACE, &terminal::signal),
        Stop::Ignored => {}
    }
}

/// Leave with [`INTERRUPTED`], the cursor visible and the terminal in the mode
/// the run started in. The run calls it once it reported what a child Ctrl+C
/// stopped left behind ([`child_stopped`]).
pub(crate) fn exit_interrupted() -> ! {
    let _ = console::Term::stderr().show_cursor();
    if let Some(start) = START
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
    {
        start.restore();
    }
    std::process::exit(INTERRUPTED);
}

/// Run one Postgres statement that Ctrl+C cancels on the server. `cancel`
/// sends the cancel request for it, and `refused` tells an error the server
/// reported, after which the transaction rolled back, from a connection that
/// failed without saying how the statement ended.
///
/// After Ctrl+C the handler owns the rest of the run: no statement starts, and
/// a statement that ends hands its outcome to the handler and never returns
/// here, since the process is on its way out.
pub(crate) fn cancellable<T, E>(
    cancel: Cancel,
    statement: impl FnOnce() -> Result<T, E>,
    refused: impl FnOnce(&E) -> bool,
) -> Result<T, E> {
    if !STATEMENTS.begin(cancel) {
        wait_for_exit();
    }
    let result = statement();
    let ended = match &result {
        Err(cause) if refused(cause) => Ended::Refused,
        Ok(_) | Err(_) => Ended::Unconfirmed,
    };
    if !STATEMENTS.end(ended) {
        wait_for_exit();
    }

    result
}

/// Wait for the child process `pid` through `wait`, with Ctrl+C stopping the
/// child rather than the run: afterwards [`child_stopped`] says whether it
/// did. A child spawned after Ctrl+C already stopped the run is interrupted
/// at once, and the handler owns the exit.
pub(crate) fn supervised<T>(pid: u32, wait: impl FnOnce() -> T) -> T {
    if !STATEMENTS.begin_child(pid) {
        terminal::signal(pid, Signal::Interrupt);
        wait_for_exit();
    }
    let waited = wait();
    STATEMENTS.end_child();

    waited
}

/// Whether Ctrl+C stopped the last [`supervised`] child. The run then reports
/// what the child left and calls [`exit_interrupted`].
pub(crate) fn child_stopped() -> bool {
    STATEMENTS.child_stopped()
}

fn wait_for_exit() -> ! {
    loop {
        std::thread::park();
    }
}

/// Ctrl+C as a key for as long as a question is on screen.
///
/// A question reads each key in raw mode, but it draws in the mode the shell
/// left, where Ctrl+C is SIGINT. The guard turns ISIG off until it drops, so
/// a Ctrl+C typed while the question is still being drawn waits in the input
/// for the question to read, like any other key.
pub(crate) struct KeysAtPrompt {
    _held: Option<terminal::WithoutSignals>,
}

impl KeysAtPrompt {
    /// Hold the keys of the terminal on stdin. Off a terminal it holds nothing.
    pub(crate) fn hold() -> Self {
        Self {
            _held: terminal::WithoutSignals::of_stdin(),
        }
    }
}

// MARK: - statements

static STATEMENTS: Statements = Statements::new();

/// How a statement ended, as far as the server said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ended {
    /// The server reported an error for it, a cancel included, so its
    /// transaction rolled back.
    Refused,
    /// It ran to the end, commit included, or the connection failed without
    /// the server saying.
    Unconfirmed,
}

/// The supervised child, as the run and the handler share it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Child {
    /// No child runs.
    Idle,
    /// The child with this process id runs.
    Running(u32),
    /// Ctrl+C signalled the child with this process id, which has not exited.
    Stopping(u32),
    /// The child Ctrl+C signalled has exited.
    Stopped,
}

/// What the handler does about one Ctrl+C.
#[derive(Debug, PartialEq, Eq)]
enum Stop {
    /// Print this line and exit.
    Line(&'static str),
    /// Stop the child with this process id and leave the exit to the run.
    Child(u32),
    /// Nothing: an earlier Ctrl+C stopped the child, and the run reports what
    /// it left before it exits.
    Ignored,
}

/// The two signals a supervised child gets, in the order it gets them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Signal {
    Interrupt,
    Terminate,
}

/// The statement in flight, as the transport and the handler share it.
struct Flight {
    /// Ctrl+C arrived, so no statement starts from here on.
    stopping: bool,
    /// The cancel request for the statement running now.
    cancel: Option<Cancel>,
    /// How the statement the handler cancelled ended.
    ended: Option<Ended>,
    child: Child,
}

struct Statements {
    flight: Mutex<Flight>,
    ended: Condvar,
    exited: Condvar,
}

impl Statements {
    const fn new() -> Self {
        Self {
            flight: Mutex::new(Flight {
                stopping: false,
                cancel: None,
                ended: None,
                child: Child::Idle,
            }),
            ended: Condvar::new(),
            exited: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Flight> {
        self.flight.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether the statement may start, which it may not after Ctrl+C.
    fn begin(&self, cancel: Cancel) -> bool {
        let mut flight = self.lock();
        if flight.stopping {
            return false;
        }
        flight.cancel = Some(cancel);

        true
    }

    /// Whether the run goes on after the statement. After Ctrl+C it does
    /// not: the handler learns how the statement ended.
    fn end(&self, ended: Ended) -> bool {
        let mut flight = self.lock();
        flight.cancel = None;
        if !flight.stopping {
            return true;
        }
        flight.ended = Some(ended);
        self.ended.notify_all();

        false
    }

    /// Whether the child `pid` may run, which it may not after Ctrl+C.
    fn begin_child(&self, pid: u32) -> bool {
        let mut flight = self.lock();
        if flight.stopping {
            return false;
        }
        flight.child = Child::Running(pid);

        true
    }

    /// The child exited: a stopped one wakes the handler waiting for it.
    fn end_child(&self) {
        let mut flight = self.lock();
        flight.child = match flight.child {
            Child::Stopping(_) => Child::Stopped,
            Child::Idle | Child::Running(_) | Child::Stopped => Child::Idle,
        };
        self.exited.notify_all();
    }

    fn child_stopped(&self) -> bool {
        self.lock().child == Child::Stopped
    }

    /// The handler's half: a running child is left to [`Self::stop_child`],
    /// and once it is stopped every later Ctrl+C is ignored. Otherwise stop
    /// every later statement, cancel the one in flight, and name what
    /// happened to its transaction.
    fn stop(&self, wait: Duration) -> Stop {
        let cancel = {
            let mut flight = self.lock();
            match flight.child {
                Child::Running(pid) => {
                    flight.child = Child::Stopping(pid);

                    return Stop::Child(pid);
                }
                Child::Stopping(_) | Child::Stopped => return Stop::Ignored,
                Child::Idle => {}
            }
            flight.stopping = true;
            flight.cancel.take()
        };
        let Some(cancel) = cancel else {
            return Stop::Line(NOT_APPLIED);
        };
        let _ = within(wait, cancel);
        let (flight, _) = self
            .ended
            .wait_timeout_while(self.lock(), wait, |flight| flight.ended.is_none())
            .unwrap_or_else(PoisonError::into_inner);

        match flight.ended {
            Some(Ended::Refused) => Stop::Line(NOT_APPLIED),
            Some(Ended::Unconfirmed) | None => Stop::Line(MAY_HAVE_COMMITTED),
        }
    }

    /// Send the child SIGINT, then SIGTERM once `grace` passed with the child
    /// still running, and return when it has exited.
    fn stop_child(&self, pid: u32, grace: Duration, send: &dyn Fn(u32, Signal)) {
        let running = |flight: &mut Flight| matches!(flight.child, Child::Stopping(_));
        send(pid, Signal::Interrupt);
        let (flight, waited) = self
            .exited
            .wait_timeout_while(self.lock(), grace, running)
            .unwrap_or_else(PoisonError::into_inner);
        if !waited.timed_out() {
            return;
        }
        drop(flight);

        send(pid, Signal::Terminate);
        drop(
            self.exited
                .wait_while(self.lock(), running)
                .unwrap_or_else(PoisonError::into_inner),
        );
    }
}

/// Runs `work` on a thread of its own and waits at most `wait` for its
/// answer, so a server that never answers cannot keep the process from
/// exiting: `None` when no answer came in time. Work still running then is
/// left to end with the process.
pub(crate) fn within<T: Send + 'static>(
    wait: Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (sent, answer) = mpsc::channel();
    std::thread::Builder::new()
        .spawn(move || {
            let _ = sent.send(work());
        })
        .ok()?;

    answer.recv_timeout(wait).ok()
}

// MARK: - terminal modes

#[cfg(unix)]
mod terminal {
    use std::os::fd::{AsFd, BorrowedFd, OwnedFd};

    use nix::sys::signal::{Signal as Posix, kill};
    use nix::sys::termios::{LocalFlags, SetArg, Termios, tcgetattr, tcsetattr};
    use nix::unistd::Pid;

    use super::Signal;

    /// Send `signal` to the process `pid`. A process that already exited
    /// has nothing left to stop.
    pub(super) fn signal(pid: u32, signal: Signal) {
        let Ok(pid) = i32::try_from(pid) else {
            return;
        };
        let posix = match signal {
            Signal::Interrupt => Posix::SIGINT,
            Signal::Terminate => Posix::SIGTERM,
        };
        let _ = kill(Pid::from_raw(pid), posix);
    }

    /// A terminal and the mode to put back on it.
    pub(super) struct Saved {
        fd: OwnedFd,
        mode: Termios,
    }

    impl Saved {
        pub(super) fn of_stdin() -> Option<Self> {
            Self::of(std::io::stdin().as_fd())
        }

        /// `None` when `fd` is not a terminal.
        pub(super) fn of(fd: BorrowedFd<'_>) -> Option<Self> {
            let mode = tcgetattr(fd).ok()?;
            let fd = fd.try_clone_to_owned().ok()?;

            Some(Self { fd, mode })
        }

        pub(super) fn restore(&self) {
            let _ = tcsetattr(&self.fd, SetArg::TCSANOW, &self.mode);
        }
    }

    /// ISIG off until the value drops, then the mode it found.
    pub(super) struct WithoutSignals(Saved);

    impl WithoutSignals {
        pub(super) fn of_stdin() -> Option<Self> {
            Self::hold(std::io::stdin().as_fd())
        }

        pub(super) fn hold(fd: BorrowedFd<'_>) -> Option<Self> {
            let saved = Saved::of(fd)?;
            let mut held = saved.mode.clone();
            held.local_flags.remove(LocalFlags::ISIG);
            tcsetattr(&saved.fd, SetArg::TCSANOW, &held).ok()?;

            Some(Self(saved))
        }
    }

    impl Drop for WithoutSignals {
        fn drop(&mut self) {
            self.0.restore();
        }
    }
}

/// Terminal modes and signals here are POSIX, which only Unix has: elsewhere
/// the guard, the restore, and the signal do nothing, and the console hands
/// Ctrl+C to the child itself.
#[cfg(not(unix))]
mod terminal {
    use super::Signal;

    pub(super) fn signal(_pid: u32, _signal: Signal) {}

    pub(super) struct Saved;

    impl Saved {
        pub(super) fn of_stdin() -> Option<Self> {
            None
        }

        pub(super) fn restore(&self) {}
    }

    pub(super) struct WithoutSignals;

    impl WithoutSignals {
        pub(super) fn of_stdin() -> Option<Self> {
            None
        }
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::sync::Arc;
    use std::sync::mpsc::channel;
    use std::thread::JoinHandle;

    use super::*;

    const LONG: Duration = Duration::from_secs(5);

    /// A statement on its own thread that runs until the handler's cancel
    /// request reaches it, then ends as `ended`. The thread answers whether
    /// the run would go on.
    fn statement_ending(statements: &Arc<Statements>, ended: Ended) -> JoinHandle<bool> {
        let (cancelled, reached) = channel();
        let (started, running) = channel();
        let shared = Arc::clone(statements);
        let statement = std::thread::spawn(move || {
            let began = shared.begin(Box::new(move || {
                let _ = cancelled.send(());
            }));
            started.send(began).unwrap();
            reached.recv().unwrap();
            shared.end(ended)
        });
        assert!(running.recv().unwrap(), "the statement starts");

        statement
    }

    #[test]
    fn a_statement_the_cancel_request_stopped_is_reported_not_applied() {
        let statements = Arc::new(Statements::new());
        let statement = statement_ending(&statements, Ended::Refused);

        assert_eq!(statements.stop(LONG), Stop::Line(NOT_APPLIED));
        assert!(!statement.join().unwrap(), "the handler owns the exit");
    }

    #[test]
    fn a_statement_the_server_did_not_confirm_stopped_is_never_reported_not_applied() {
        let statements = Arc::new(Statements::new());
        let statement = statement_ending(&statements, Ended::Unconfirmed);

        assert_eq!(statements.stop(LONG), Stop::Line(MAY_HAVE_COMMITTED));
        assert!(!statement.join().unwrap());
    }

    #[test]
    fn a_statement_that_never_ends_is_never_reported_not_applied() {
        let statements = Statements::new();
        assert!(statements.begin(Box::new(|| {})));

        assert_eq!(
            statements.stop(Duration::from_millis(20)),
            Stop::Line(MAY_HAVE_COMMITTED)
        );
    }

    #[test]
    fn with_no_statement_in_flight_nothing_was_applied_and_none_starts_after() {
        let statements = Statements::new();
        assert!(statements.begin(Box::new(|| {})));
        assert!(statements.end(Ended::Unconfirmed), "the run goes on");

        assert_eq!(statements.stop(LONG), Stop::Line(NOT_APPLIED));
        assert!(!statements.begin(Box::new(|| {})));
    }

    /// `stop_child` for `pid` on its own thread, as the handler runs it. The
    /// receiver hears every signal it sends, in order.
    fn stopping_child(
        statements: &Arc<Statements>,
        pid: u32,
        grace: Duration,
    ) -> (JoinHandle<()>, std::sync::mpsc::Receiver<(u32, Signal)>) {
        let (sent, signalled) = channel();
        let shared = Arc::clone(statements);
        let handler = std::thread::spawn(move || {
            let sent = Mutex::new(sent);
            shared.stop_child(pid, grace, &|pid, signal| {
                let _ = sent.lock().unwrap().send((pid, signal));
            });
        });

        (handler, signalled)
    }

    #[test]
    fn ctrl_c_during_a_child_interrupts_it_and_waits_for_it_to_exit() {
        let statements = Arc::new(Statements::new());
        assert!(statements.begin_child(42));

        assert_eq!(statements.stop(LONG), Stop::Child(42));
        let (handler, signalled) = stopping_child(&statements, 42, LONG);
        assert_eq!(signalled.recv().unwrap(), (42, Signal::Interrupt));
        statements.end_child();
        handler.join().unwrap();

        assert!(signalled.try_recv().is_err(), "no SIGTERM once it exited");
        assert!(statements.child_stopped(), "the run reports what it left");
    }

    #[test]
    fn a_child_still_running_after_the_grace_is_terminated_then_waited_for() {
        let statements = Arc::new(Statements::new());
        assert!(statements.begin_child(42));

        assert_eq!(statements.stop(LONG), Stop::Child(42));
        let (handler, signalled) = stopping_child(&statements, 42, Duration::from_millis(20));
        assert_eq!(signalled.recv().unwrap(), (42, Signal::Interrupt));
        assert_eq!(signalled.recv().unwrap(), (42, Signal::Terminate));
        assert!(!handler.is_finished(), "the handler waits for the exit");
        statements.end_child();
        handler.join().unwrap();

        assert!(statements.child_stopped());
    }

    /// Once Ctrl+C stopped the child, another Ctrl+C neither ends the run
    /// nor cancels the history read of its report.
    #[test]
    fn ctrl_c_while_the_run_reports_on_a_stopped_child_is_ignored() {
        let statements = Statements::new();
        assert!(statements.begin_child(42));
        assert_eq!(statements.stop(LONG), Stop::Child(42));

        assert_eq!(statements.stop(LONG), Stop::Ignored, "the child is exiting");
        statements.end_child();
        let (cancelled, sent) = channel();
        assert!(statements.begin(Box::new(move || {
            let _ = cancelled.send(());
        })));
        assert_eq!(statements.stop(LONG), Stop::Ignored, "the report reads");

        assert!(sent.try_recv().is_err(), "the read is never cancelled");
        assert!(statements.end(Ended::Unconfirmed), "the report goes on");
        assert!(statements.child_stopped());
    }

    #[test]
    fn ctrl_c_after_the_child_exited_is_the_statement_path() {
        let statements = Statements::new();
        assert!(statements.begin_child(42));
        statements.end_child();

        assert_eq!(statements.stop(LONG), Stop::Line(NOT_APPLIED));
        assert!(!statements.child_stopped());
    }

    #[test]
    fn no_child_starts_after_ctrl_c() {
        let statements = Statements::new();

        assert_eq!(statements.stop(LONG), Stop::Line(NOT_APPLIED));
        assert!(!statements.begin_child(42));
    }

    #[cfg(unix)]
    #[test]
    fn the_interrupt_reaches_the_child_process() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};

        let mut child = Command::new("sh")
            .args([
                "-c",
                "trap 'exit 7' INT; echo ready; while :; do sleep 0.05; done",
            ])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready.trim(), "ready");

        terminal::signal(child.id(), Signal::Interrupt);

        assert_eq!(child.wait().unwrap().code(), Some(7));
    }

    #[test]
    fn work_that_never_answers_is_given_up_on_after_the_wait() {
        let started = std::time::Instant::now();
        let answer = within(Duration::from_millis(20), || {
            std::thread::sleep(Duration::from_secs(30));
        });

        assert_eq!(answer, None);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn work_that_answers_in_time_hands_its_answer_back() {
        assert_eq!(within(LONG, || 7), Some(7));
    }

    #[cfg(unix)]
    #[test]
    fn a_question_turns_signals_off_until_it_ends() {
        use std::os::fd::AsFd;

        use nix::pty::openpty;
        use nix::sys::termios::{LocalFlags, tcgetattr};

        let pty = openpty(None, None).unwrap();
        let signals = || {
            tcgetattr(pty.slave.as_fd())
                .unwrap()
                .local_flags
                .contains(LocalFlags::ISIG)
        };
        assert!(signals());

        let held = terminal::WithoutSignals::hold(pty.slave.as_fd()).unwrap();
        assert!(
            !signals(),
            "Ctrl+C is a key while the question is on screen"
        );
        drop(held);

        assert!(signals(), "the mode the question found is back");
    }
}
