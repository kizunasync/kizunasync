//! The TTY wizard's colours: Sumi & Vermilion on the terminal.
//!
//! The theme token file is CSS; a CLI cannot import it. These RGB values are the
//! brand accent (`#e5484d` / `oklch(0.62 0.21 29)`) and the site's ok green,
//! applied through cliclack's [`Theme`] so every prompt, bar, and radio shares
//! one look. `set_theme` is process-global; [`apply`] is idempotent.

use cliclack::{Theme, ThemeState, set_theme};
use console::{Emoji, Style, Term, colors_enabled_stderr, style};
use std::cell::{Cell, RefCell};
use std::fmt::Write as _;
use std::io::{self, IsTerminal, Write};
use std::sync::Once;

use crate::prompts::BackKey;

/// Brand accent: `packages/ui` `--color-site-accent` / `#e5484d`.
pub(crate) const VERMILION: (u8, u8, u8) = (229, 72, 77);
/// Brand hover / bright vermilion: `packages/ui` `--color-site-accent-bright`.
const VERMILION_BRIGHT: (u8, u8, u8) = (240, 103, 107);
/// Approximate `--color-site-muted`, for the faded "Sync" wordmark.
const MUTED: (u8, u8, u8) = (167, 164, 178);
/// Approximate `--color-site-faint`, the end of the "Sync" fade.
const FAINT: (u8, u8, u8) = (118, 114, 127);

/// Columns belonging to the 絆. Everything after the gap is the wordmark.
const KANJI_COLS: usize = 22;
const GAP: usize = 2;
/// First row of the muted "Sync". Rows above it, in the wordmark columns, are "Kizuna".
const SYNC_FROM_ROW: usize = 6;

/// 絆 in quadrant blocks, with Kizuna / Sync in half-block letters beside it.
///
/// The words are sampled from a bold face at five rows, so they read larger
/// than a single line of terminal text and still fit an 80-column screen.
/// The TTY path fades it; `NO_COLOR` and tests use this plaintext.
#[rustfmt::skip]
pub(crate) const BANNER: &str = "   ▟▙▄       ▗▄▄▖       ██  ▄██▀  █
   █▛▘▄▖  ▐█▄▞██ ▐▄▖    ██ ▄█▀    ▄  ▄▄▄▄▄▄ ▄▄   ▄▄ ▄▄▄▄█▄▄  ▄▄█▄▄
 ▄▟▀ ▗██▘ ██▘ ██  ▐█▙   █████     █    ▄█▀  ██   █  ▄█▀  ██  ▀ ▄▄█
 ▝█▙▗█▛  ▟▛   ██   ▜█▘  ██  ▀█▄   █  ▄██▀   ██   █  ██   ██ ▄█▀▀▀█
  ▝▚█▀▗▖ ▘    ██ ▗▟▙▖   ██   ▀██  █  ██████ ▀███▀█▀ ▀█   ██ ▀█▄▄▀██
▗▄▄█▙▄▄█▙▖▀▀▀▀██▀▀▀▀▘
▝▛▀▀██ ▝█▘    ██   ▄▖   ▄█▀▀█▄
 ▗▄▄██ ▄ ▄▄▄▄▄██▄▄▟██▌  ▀█▄▄   █▄ ▄█ █▄▀█▄ ▄█▀█▄
 ██▘██ ▜█▖    ██          ▀▀▀█ ▀█▄█  █  ██ █
 █▘ ██ ▝█▌    ██        ▀█▄▄█▀  ▀█   █  ▀█ ▀█▄█▀
▐▘  ██       ▗██               ▄█▀
    ██▘      ▐█▛";

/// Install the theme once per process. Safe to call from every prompter
/// construction; later calls are no-ops.
pub fn apply() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| set_theme(VermilionTheme));
}

pub(crate) struct VermilionTheme;

/// Which keys the open question actually honors.
#[derive(Clone, Copy)]
pub(crate) enum KeyHint {
    /// Yes / No on one line. Left and right move.
    Confirm,
    /// A vertical list. Up and down move.
    List,
    /// Checkboxes. Up and down move, space toggles.
    Multi,
    /// A typed field. Backspace edits, then steps back when the field is empty.
    Text,
}

thread_local! {
    static KEY_HINT: Cell<(KeyHint, BackKey)> = const { Cell::new((KeyHint::List, BackKey::Honoured)) };
}

pub(crate) fn set_key_hint(hint: KeyHint, back: BackKey) {
    KEY_HINT.set((hint, back));
}

/// The gray key line under an open question: the keys that question uses,
/// then Ctrl+C, which every question takes.
pub(crate) fn key_legend_text(hint: KeyHint, back: BackKey) -> String {
    let enter = Emoji("↵", "Enter");
    let back = match back {
        BackKey::Honoured => format!("   {} back", Emoji("⌫", "Backspace")),
        BackKey::Ignored => String::new(),
    };
    let keys = match hint {
        KeyHint::Confirm => format!(
            "{enter} continue{back}   {}{} move",
            Emoji("←", "left"),
            Emoji("→", "right"),
        ),
        KeyHint::List => format!(
            "{enter} continue{back}   {}{} move",
            Emoji("↑", "up"),
            Emoji("↓", "down"),
        ),
        KeyHint::Multi => format!(
            "{enter} continue{back}   {}{} move   {} select",
            Emoji("↑", "up"),
            Emoji("↓", "down"),
            Emoji("␣", "space"),
        ),
        KeyHint::Text => format!("{enter} continue{back}"),
    };

    format!("{keys}   ctrl+c quit")
}

fn key_rule() -> String {
    let columns = Term::stderr().size().1 as usize;
    "─".repeat(columns.max(1))
}

pub(crate) fn vermilion() -> Style {
    Style::new().true_color(VERMILION.0, VERMILION.1, VERMILION.2)
}

/// Paint the faded lockup on stderr, then a blank line so the Clack intro
/// sits under it. No-ops when stderr is not a TTY. `NO_COLOR` prints
/// [`BANNER`] without colour.
pub(crate) fn print_banner() {
    if !io::stderr().is_terminal() {
        return;
    }
    let lines: Vec<String> = if colors_enabled_stderr() {
        faded_lockup()
    } else {
        BANNER.lines().map(str::to_owned).collect()
    };
    let mut body = String::new();
    for line in lines {
        body.push_str(&line);
        body.push('\n');
    }
    body.push('\n');
    // A write failure here (a closed stderr pipe) only drops the decorative
    // banner; the wizard has nothing to report and nothing to retry.
    if write_committed(&body).is_err() {
        let _ = io::stderr().write_all(body.as_bytes());
    }
}

// MARK: - wizard scroll

/// A point Backspace can return to. Everything drawn after it is wiped.
#[derive(Clone, Copy)]
pub(crate) struct Mark {
    rows: usize,
    depth: usize,
}

struct Trail {
    live: bool,
    rows: usize,
    marks: Vec<usize>,
}

thread_local! {
    static TRAIL: RefCell<Trail> = const {
        RefCell::new(Trail {
            live: false,
            rows: 0,
            marks: Vec::new(),
        })
    };
}

/// Start counting wizard rows. A second intro replaces the count: the previous
/// screen stays, and only the new section is erasable.
pub(crate) fn session_begin() {
    if cfg!(test) || !io::stderr().is_terminal() {
        return;
    }
    TRAIL.with(|trail| {
        *trail.borrow_mut() = Trail {
            live: true,
            rows: 0,
            marks: Vec::new(),
        };
    });
}

/// Stop routing status through the bar. The outro's trailing log stays plain.
pub(crate) fn session_end() {
    TRAIL.with(|trail| trail.borrow_mut().live = false);
}

fn trail_live() -> bool {
    TRAIL.with(|trail| trail.borrow().live)
}

/// The terminal's width in columns, at least one.
pub(crate) fn columns() -> usize {
    usize::from(Term::stderr().size().1).max(1)
}

/// The columns a status line has on the left bar of a live wizard, `None`
/// outside one.
pub(crate) fn bar_width() -> Option<usize> {
    trail_live().then(|| columns().saturating_sub(BAR_LEAD))
}

/// The bar and the two spaces every line on it starts with.
const BAR_LEAD: usize = 3;

/// Where a hint too long for its item's row goes: under the label, past the
/// radio or checkbox and its space.
const HINT_INDENT: usize = 2;

/// `text` cut into lines of at most `width` columns, only where `separator`
/// stands. The separator's visible part stays at the end of the line it
/// closes. A piece wider than `width` is cut at its spaces instead, and a word
/// wider than `width` stays whole, so no word is ever split.
pub(crate) fn wrap_at(text: &str, width: usize, separator: &str) -> Vec<String> {
    let pieces = wrap_pieces(text, width, separator);
    let mut lines = Vec::new();
    let mut line = String::new();
    for (index, piece) in pieces.iter().enumerate() {
        // Room for the separator a break before the next piece would leave.
        let reserve = pieces.get(index + 1).map_or(0, |next| {
            console::measure_text_width(next.joiner.trim_end())
        });
        let candidate = format!("{line}{}{}", piece.joiner, piece.text);
        let fits = console::measure_text_width(&candidate) + reserve <= width;
        if line.is_empty() || (fits && !piece.fresh) {
            line = candidate;
            continue;
        }

        lines.push(format!("{line}{}", piece.joiner.trim_end()));
        piece.text.clone_into(&mut line);
    }
    lines.push(line);

    lines
}

/// One piece [`wrap_at`] places: its text and the separator before it.
struct WrapPiece<'a> {
    joiner: &'a str,
    text: &'a str,
    /// The first word of a piece too wide for a line, which starts a line of
    /// its own.
    fresh: bool,
}

/// `text` split where `separator` stands; a piece wider than `width` comes as
/// its words instead.
fn wrap_pieces<'a>(text: &'a str, width: usize, separator: &'a str) -> Vec<WrapPiece<'a>> {
    let segments: Vec<&str> = text.split(separator).collect();
    let glue = console::measure_text_width(separator.trim_end());
    let mut pieces = Vec::new();
    for (index, piece) in segments.iter().copied().enumerate() {
        let joiner = if index == 0 { "" } else { separator };
        let closer = if index + 1 < segments.len() { glue } else { 0 };
        if separator == " " || console::measure_text_width(piece) + closer <= width {
            pieces.push(WrapPiece {
                joiner,
                text: piece,
                fresh: false,
            });
            continue;
        }

        for (word_index, word) in piece.split(' ').enumerate() {
            pieces.push(WrapPiece {
                joiner: if word_index == 0 { joiner } else { " " },
                text: word,
                fresh: word_index == 0,
            });
        }
    }

    pieces
}

/// An item and its hint on the bar: one row when both fit in `width`, else
/// the hint on rows of its own under the label, cut at its spaces.
fn hinted_rows(
    bar: &str,
    item: &str,
    hint: &str,
    width: usize,
    paint: impl Fn(&str) -> String,
) -> String {
    if console::measure_text_width(item) + console::measure_text_width(hint) <= width {
        return format!("{bar}  {item}{}\n", paint(hint));
    }

    let indent = " ".repeat(HINT_INDENT);
    let mut rows = format!("{bar}  {}\n", item.trim_end());
    for line in wrap_at(hint, width.saturating_sub(HINT_INDENT), " ") {
        // Writing into a String cannot fail.
        let _ = writeln!(rows, "{bar}  {indent}{}", paint(&line));
    }

    rows
}

/// Remember the cursor as a step boundary.
#[must_use]
pub(crate) fn mark() -> Mark {
    TRAIL.with(|trail| {
        let mut trail = trail.borrow_mut();
        if !trail.live {
            return Mark { rows: 0, depth: 0 };
        }
        let rows = trail.rows;
        trail.marks.push(rows);
        Mark {
            rows,
            depth: trail.marks.len(),
        }
    })
}

/// Erase every row drawn since `mark`, including a submitted answer.
pub(crate) fn rewind(mark: Mark) {
    TRAIL.with(|trail| {
        let mut trail = trail.borrow_mut();
        if !trail.live {
            return;
        }
        let extra = trail.rows.saturating_sub(mark.rows);
        trail.rows = mark.rows;
        trail.marks.truncate(mark.depth.saturating_sub(1));
        if extra > 0 {
            let _ = Term::stderr().clear_last_lines(extra);
        }
    });
}

/// Count `rendered` after it has already been written to the terminal.
pub(crate) fn commit_text(rendered: &str) {
    TRAIL.with(|trail| {
        let mut trail = trail.borrow_mut();
        if trail.live {
            trail.rows = trail.rows.saturating_add(visual_rows(rendered));
        }
    });
}

/// Count `rendered`, already written to stdout, when stdout is the terminal
/// the wizard draws on, so a later [`rewind`] erases it with the rows around
/// it.
pub(crate) fn commit_stdout(rendered: &str) {
    if io::stdout().is_terminal() {
        commit_text(rendered);
    }
}

/// Write `rendered` and count its rows, so a later [`rewind`] can remove it.
pub(crate) fn write_committed(rendered: &str) -> io::Result<()> {
    let term = Term::stderr();
    term.write_str(rendered)?;
    term.flush()?;
    commit_text(rendered);
    Ok(())
}

/// `Ui` status during a live wizard: the same bytes, on the left bar.
///
/// Returns whether the line was taken. Outside a session the caller writes it
/// plain, which is what tests capture.
pub(crate) fn capture_log(text: &str) -> bool {
    if !trail_live() {
        return false;
    }
    let rendered = render_bar_block(&format!("{text}\n"));
    let _ = write_committed(&rendered);
    true
}

/// One labelled fact between questions (`database: …`). On a live wizard it
/// sits on the bar, with a single space after the colon and a bar under it so
/// the next question keeps the usual gap. Otherwise the caller's padding is
/// kept for the plain report.
pub(crate) fn detail(ui: &mut crate::ui::Ui, text: &str) {
    if !trail_live() {
        ui.log(text);
        return;
    }
    let _ = write_committed(&detail_block(text));
}

fn detail_block(text: &str) -> String {
    let mut rendered = render_bar_block(&format!("{}\n", tighten_field(text)));
    rendered.push_str(&submit_bar());
    rendered.push('\n');
    rendered
}

/// The report pads `database:` out to a column. Between two questions that
/// padding is a hole, so the wizard keeps one space.
fn tighten_field(text: &str) -> String {
    let trimmed = text.trim();
    let Some((label, value)) = trimmed.split_once(':') else {
        return trimmed.to_owned();
    };
    let value = value.trim_start();
    if value.is_empty() {
        return trimmed.to_owned();
    }
    format!("{label}: {value}")
}

fn render_bar_block(logged: &str) -> String {
    let bar = submit_bar();
    let mut lines: Vec<&str> = logged.split('\n').collect();
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    let mut out = String::new();
    for line in lines {
        out.push_str(&bar);
        out.push_str("  ");
        out.push_str(line.trim_start());
        out.push('\n');
    }
    out
}

fn submit_bar() -> String {
    VermilionTheme
        .bar_color(&ThemeState::Submit)
        .apply_to(Emoji("│", "|").to_string())
        .to_string()
}

pub(crate) fn info_log(text: &str) -> String {
    let symbol = VermilionTheme.info_symbol();
    VermilionTheme.format_log(text, &symbol)
}

pub(crate) fn remark_log(text: &str) -> String {
    let symbol = VermilionTheme.remark_symbol();
    VermilionTheme.format_log(text, &symbol)
}

/// A rule heading above its one-sentence explanation.
///
/// The name is the link: OSC 8 carries the URL, and the words stay on screen.
/// A short rule sits after the name so the heading reads apart from the sentence.
pub(crate) fn rule_card(name: &str, url: &str, body: &str) -> String {
    let bar = submit_bar();
    let mark = VermilionTheme.remark_symbol();
    let linked = crate::docs::hyperlink(&vermilion().apply_to(name).to_string(), url);
    let rule = Style::new()
        .true_color(FAINT.0, FAINT.1, FAINT.2)
        .apply_to("─".repeat(16));
    let mut out = format!("{mark}  {linked}  {rule}\n");
    for line in body.lines() {
        let sentence = Style::new()
            .true_color(MUTED.0, MUTED.1, MUTED.2)
            .apply_to(line);
        out.push_str(&bar);
        out.push_str("  ");
        out.push_str(&sentence.to_string());
        out.push('\n');
    }
    out
}

pub(crate) fn note_block(title: &str, message: &str) -> String {
    VermilionTheme.format_note(title, message)
}

pub(crate) fn outro_line(message: &str) -> String {
    VermilionTheme.format_outro(message)
}

pub(crate) fn outro_cancel_line(message: &str) -> String {
    VermilionTheme.format_outro_cancel(message)
}

pub(crate) fn intro_line(title: &str) -> String {
    VermilionTheme.format_intro(title)
}

/// The lines a finished spinner leaves once indicatif has cleared the ticker.
pub(crate) fn finished_spin(message: &str) -> String {
    let rendered =
        VermilionTheme.format_progress_with_state(message, false, false, &ThemeState::Submit);
    format!("{rendered}\n")
}

/// Terminal rows `rendered` occupies at the current stderr width.
pub(crate) fn visual_rows(rendered: &str) -> usize {
    let cols = usize::from(Term::stderr().size().1).max(1);
    visual_rows_at(rendered, cols)
}

/// The same count at an explicit width, for tests.
pub(crate) fn visual_rows_at(rendered: &str, cols: usize) -> usize {
    let cols = cols.max(1);
    let mut rows = 0;
    let mut parts = rendered.split('\n').peekable();
    while let Some(line) = parts.next() {
        if line.is_empty() && parts.peek().is_none() {
            break;
        }
        let width = console::measure_text_width(&strip_osc(line));
        rows += if width == 0 { 1 } else { width.div_ceil(cols) };
    }
    rows
}

/// OSC 8 hyperlinks are not ANSI colors. Counting them as ink would make
/// Backspace erase the step above the one it is returning to.
fn strip_osc(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(start) = rest.find("\u{1b}]") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some(bel) = after.find('\u{7}') {
            rest = &after[bel + 1..];
        } else if let Some(st) = after.find("\u{1b}\\") {
            rest = &after[st + 2..];
        } else {
            rest = after;
            break;
        }
    }
    out.push_str(rest);
    out
}

fn faded_lockup() -> Vec<String> {
    let rows = BANNER.lines().count().saturating_sub(1);
    BANNER
        .lines()
        .enumerate()
        .map(|(row, line)| fade_lockup_row(line, row, rows))
        .collect()
}

fn fade_lockup_row(line: &str, row: usize, last_row: usize) -> String {
    let kanji_c = mix_rgb(VERMILION_BRIGHT, VERMILION, row, last_row);
    line.chars()
        .enumerate()
        .map(|(col, ch)| {
            if ch == ' ' {
                return " ".to_owned();
            }
            let color = if col < KANJI_COLS {
                kanji_c
            } else {
                word_fade(row, col)
            };
            fg(color, ch)
        })
        .collect()
}

fn word_fade(row: usize, col: usize) -> (u8, u8, u8) {
    let local = col.saturating_sub(KANJI_COLS + GAP);
    if row < SYNC_FROM_ROW {
        mix_rgb(VERMILION_BRIGHT, VERMILION, local, 8)
    } else {
        mix_rgb(MUTED, FAINT, local, 6)
    }
}

fn mix_rgb(from: (u8, u8, u8), to: (u8, u8, u8), step: usize, last: usize) -> (u8, u8, u8) {
    (
        mix(from.0, to.0, step, last),
        mix(from.1, to.1, step, last),
        mix(from.2, to.2, step, last),
    )
}

fn mix(from: u8, to: u8, step: usize, last: usize) -> u8 {
    let last = last.max(1);
    let step = step.min(last);
    let from = u16::from(from);
    let to_u = u16::from(to);
    let last = u16::try_from(last).unwrap_or(1);
    let step = u16::try_from(step).unwrap_or(last);
    u8::try_from((from * (last - step) + to_u * step) / last).unwrap_or(to)
}

fn fg(rgb: (u8, u8, u8), ch: char) -> String {
    Style::new()
        .true_color(rgb.0, rgb.1, rgb.2)
        .apply_to(ch)
        .to_string()
}

impl VermilionTheme {
    /// A list row: the item, then its hint in parentheses when it `shows`,
    /// wrapped to the terminal so no row runs past its right edge.
    fn item_rows(&self, state: &ThemeState, item: &str, hint: &str, shows: bool) -> String {
        let bar = self.bar_color(state).apply_to(Emoji("│", "|")).to_string();
        if !shows || hint.is_empty() {
            return format!("{bar}  {item}\n");
        }

        let style = self.placeholder_style(state);
        hinted_rows(
            &bar,
            item,
            &format!("({hint})"),
            columns().saturating_sub(BAR_LEAD),
            |text| style.apply_to(text).to_string(),
        )
    }
}

impl Theme for VermilionTheme {
    fn bar_color(&self, state: &ThemeState) -> Style {
        match state {
            ThemeState::Active => vermilion(),
            ThemeState::Cancel => Style::new().red(),
            ThemeState::Submit => Style::new().dim(),
            ThemeState::Error(_) => Style::new().yellow(),
        }
    }

    fn state_symbol_color(&self, state: &ThemeState) -> Style {
        match state {
            ThemeState::Active | ThemeState::Submit => vermilion(),
            _ => self.bar_color(state),
        }
    }

    fn state_symbol(&self, state: &ThemeState) -> String {
        let color = self.state_symbol_color(state);
        // Done is the filled diamond. The open question is the empty one.
        let glyph = match state {
            ThemeState::Active => Emoji("◇", "o"),
            ThemeState::Submit => Emoji("◆", "*"),
            ThemeState::Cancel => Emoji("■", "x"),
            ThemeState::Error(_) => Emoji("▲", "x"),
        };
        color.apply_to(glyph).to_string()
    }

    fn info_symbol(&self) -> String {
        Style::new()
            .true_color(MUTED.0, MUTED.1, MUTED.2)
            .apply_to(Emoji("●", "•"))
            .to_string()
    }

    fn radio_symbol(&self, state: &ThemeState, selected: bool) -> String {
        match state {
            ThemeState::Active if selected => vermilion().apply_to(Emoji("●", ">")).to_string(),
            ThemeState::Active => style(Emoji("○", " ")).dim().to_string(),
            _ => String::new(),
        }
    }

    fn format_footer_with_message(&self, state: &ThemeState, message: &str) -> String {
        let closing = match state {
            ThemeState::Active => format!("{}  {message}", Emoji("└", "—")),
            ThemeState::Cancel => format!("{}  Operation cancelled.", Emoji("└", "—")),
            ThemeState::Submit => Emoji("│", "|").to_string(),
            ThemeState::Error(err) => format!("{}  {err}", Emoji("└", "—")),
        };
        let bar = format!("{}\n", self.bar_color(state).apply_to(closing));
        if !matches!(state, ThemeState::Active | ThemeState::Error(_)) {
            return bar;
        }
        let faint = Style::new().true_color(FAINT.0, FAINT.1, FAINT.2);
        let rule = faint.apply_to(key_rule());
        let (hint, back) = KEY_HINT.get();
        let keys = faint.apply_to(key_legend_text(hint, back));
        format!("{bar}{rule}\n{keys}\n")
    }

    fn format_select_item(
        &self,
        state: &ThemeState,
        selected: bool,
        label: &str,
        hint: &str,
    ) -> String {
        if matches!(state, ThemeState::Cancel | ThemeState::Submit) && !selected {
            return String::new();
        }

        let shows_hint = selected && matches!(state, ThemeState::Active | ThemeState::Error(_));
        let item = self.radio_item(state, selected, label, "");
        self.item_rows(state, &item, hint, shows_hint)
    }

    fn format_multiselect_item(
        &self,
        state: &ThemeState,
        selected: bool,
        active: bool,
        label: &str,
        hint: &str,
    ) -> String {
        if matches!(state, ThemeState::Cancel | ThemeState::Submit) && !selected {
            return String::new();
        }

        let shows_hint = active && matches!(state, ThemeState::Active | ThemeState::Error(_));
        let item = self.checkbox_item(state, selected, active, label, "");
        self.item_rows(state, &item, hint, shows_hint)
    }

    fn checkbox_symbol(&self, state: &ThemeState, selected: bool, active: bool) -> String {
        match state {
            ThemeState::Active | ThemeState::Error(_) if selected => {
                vermilion().apply_to(Emoji("◼", "[+]")).to_string()
            }
            ThemeState::Active | ThemeState::Error(_) if active => {
                style(Emoji("◻", "[•]")).dim().to_string()
            }
            ThemeState::Active | ThemeState::Error(_) => style(Emoji("◻", "[ ]")).dim().to_string(),
            _ => String::new(),
        }
    }
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn the_banner_is_the_ascii_wordmark() {
        assert!(
            BANNER.lines().next().unwrap().starts_with(' '),
            "the first row keeps its indent (a trailing \\\\ would eat it)"
        );
        assert!(
            BANNER.contains('█') && BANNER.contains('▀') && BANNER.contains('▄'),
            "the 絆 is drawn with quadrant blocks"
        );
        assert!(
            BANNER
                .lines()
                .any(|line| { line.chars().skip(KANJI_COLS + GAP).any(|ch| ch != ' ') }),
            "Kizuna and Sync sit beside the mark"
        );
        assert_eq!(
            BANNER.lines().count(),
            12,
            "the lockup stays a short header"
        );
        assert!(
            BANNER.lines().all(|line| line.chars().count() <= 72),
            "the lockup fits an 80-column terminal"
        );
        assert!(!BANNER.contains("KSYNC"));
        assert!(!BANNER.contains('⣿'));
        let painted = faded_lockup();
        assert_eq!(painted.len(), BANNER.lines().count());
        assert!(painted.iter().any(|line| line.contains('█')));
    }

    #[test]
    fn vermilion_is_the_brand_accent() {
        assert_eq!(VERMILION, (229, 72, 77));
    }

    #[test]
    fn the_key_legend_follows_the_question() {
        let confirm = key_legend_text(KeyHint::Confirm, BackKey::Honoured);
        let list = key_legend_text(KeyHint::List, BackKey::Honoured);
        let multi = key_legend_text(KeyHint::Multi, BackKey::Honoured);
        let text = key_legend_text(KeyHint::Text, BackKey::Honoured);

        assert!(
            confirm.contains("continue") && confirm.contains("back") && confirm.contains("move")
        );
        assert!(!confirm.contains("select"), "{confirm}");
        assert!(
            confirm.contains('←') || confirm.contains("left"),
            "{confirm}"
        );
        assert!(list.contains('↑') || list.contains("up"), "{list}");
        assert!(!list.contains("select"), "{list}");
        assert!(multi.contains("select"), "{multi}");
        assert!(!text.contains("move"), "{text}");
    }

    #[test]
    fn a_list_that_ignores_backspace_leaves_it_out_of_the_legend() {
        let honoured = key_legend_text(KeyHint::List, BackKey::Honoured);
        let ignored = key_legend_text(KeyHint::List, BackKey::Ignored);

        assert!(honoured.contains("back"), "{honoured}");
        assert!(!ignored.contains("back"), "{ignored}");
        assert!(
            ignored.contains("continue") && ignored.contains("move"),
            "{ignored}"
        );
    }

    #[test]
    fn every_key_legend_ends_on_ctrl_c_quit() {
        for hint in [
            KeyHint::Confirm,
            KeyHint::List,
            KeyHint::Multi,
            KeyHint::Text,
        ] {
            for back in [BackKey::Honoured, BackKey::Ignored] {
                let legend = key_legend_text(hint, back);

                assert!(legend.ends_with("   ctrl+c quit"), "{legend}");
            }
        }
    }

    #[test]
    fn status_lines_keep_the_left_bar() {
        let rendered = render_bar_block(
            "kizunasync init: provisioning Kizuna into this project\n\n  integrations:     expo\n",
        );
        let plain = console::strip_ansi_codes(&rendered);
        assert!(plain.contains("provisioning Kizuna into this project"));
        assert!(plain.contains("integrations:"));
        assert!(
            plain
                .lines()
                .all(|line| line.starts_with('│') || line.starts_with('|')),
            "{plain}"
        );
        assert!(
            plain.contains("│  integrations:") || plain.contains("|  integrations:"),
            "{plain}"
        );
    }

    #[test]
    fn phase_dots_are_gray_and_finished_steps_are_a_filled_red_diamond() {
        let phase = VermilionTheme.info_symbol();
        let done = VermilionTheme.state_symbol(&ThemeState::Submit);
        let open = VermilionTheme.state_symbol(&ThemeState::Active);

        assert!(phase.contains('●'), "{phase}");
        assert!(done.contains('◆') && !done.contains('◇'), "{done}");
        assert!(open.contains('◇') && !open.contains('◆'), "{open}");
        if phase.contains('\u{1b}') {
            assert!(phase.contains("167;164;178"), "{phase}");
            assert!(done.contains("229;72;77"), "{done}");
            assert!(open.contains("229;72;77"), "{open}");
        }
    }

    #[test]
    fn a_rule_card_names_the_rule_before_the_sentence() {
        let card = rule_card(
            "Soft-delete",
            "https://kizunasync.com/docs/sync-rules-and-buckets#soft-delete",
            "A soft delete stamps a column instead of removing the row, and clients hide it.",
        );
        let name = card.find("Soft-delete").expect("name");
        let sentence = card.find("A soft delete stamps").expect("sentence");
        assert!(name < sentence);
        assert!(card.contains("https://kizunasync.com/docs/sync-rules-and-buckets#soft-delete"));
        assert!(card.contains("\u{1b}]8;;"));
    }

    #[test]
    fn a_database_line_keeps_one_space_and_a_bar_under_it() {
        let block = detail_block(
            "  database:         postgresql://postgres:***@127.0.0.1:54322/postgres (local-config)",
        );
        let plain = console::strip_ansi_codes(&block);
        let lines: Vec<&str> = plain.lines().collect();
        assert_eq!(lines.len(), 2, "{plain}");
        assert!(lines[0].contains("database: postgresql://"), "{plain}");
        assert!(!lines[0].contains("database:         "), "{plain}");
        assert!(lines[1] == "│" || lines[1] == "|", "{plain}");
    }

    /// The panel header's rule: a value breaks only at its separators, the
    /// separator stays at the end of the line it closes, and a hyphenated word
    /// stays whole.
    #[test]
    fn a_value_wraps_at_its_separators_and_never_inside_a_word() {
        let value = "4 synced · todos (read-write) · notes (pull-only) · users (read-write)";

        assert_eq!(
            wrap_at(value, 40, " · "),
            [
                "4 synced · todos (read-write) ·",
                "notes (pull-only) · users (read-write)"
            ]
        );
        assert_eq!(wrap_at(value, 200, " · "), [value]);
        for width in 14..80 {
            let lines = wrap_at(value, width, " · ");
            assert_eq!(
                lines.join(" ").replace(" · ", " ").replace(" ·", ""),
                value.replace(" · ", " "),
                "{width}"
            );
            for line in &lines {
                assert!(
                    console::measure_text_width(line) <= width,
                    "{width}: {line:?}"
                );
            }
        }
    }

    /// A piece wider than the line is cut at its spaces, and a word wider
    /// than the line stays whole.
    #[test]
    fn a_piece_wider_than_the_line_breaks_at_its_spaces() {
        assert_eq!(
            wrap_at("1 synced · a table name that is long", 14, " · "),
            ["1 synced ·", "a table name", "that is long"]
        );
        assert_eq!(
            wrap_at("attachment_confirm grants", 10, " "),
            ["attachment_confirm", "grants"]
        );
    }

    /// A hint too long for its row goes under the label, so no row runs past
    /// the terminal's right edge.
    #[test]
    fn a_long_hint_goes_under_its_label_on_rows_of_its_own() {
        let plain = |text: &str| text.to_owned();
        let item = "● Update the pack ";
        let hint = "(this CLI's pack differs · re-apply and record its hash)";

        assert_eq!(
            hinted_rows("│", item, "(short)", 77, plain),
            "│  ● Update the pack (short)\n"
        );
        let rows = hinted_rows("│", item, hint, 45, plain);
        assert_eq!(
            rows,
            "│  ● Update the pack\n\
             │    (this CLI's pack differs · re-apply and\n\
             │    record its hash)\n"
        );
        for row in rows.lines() {
            assert!(console::measure_text_width(row) <= 45 + BAR_LEAD, "{row:?}");
        }
    }

    #[test]
    fn wrapped_status_counts_terminal_rows() {
        assert_eq!(visual_rows_at("short\n", 20), 1);
        assert_eq!(visual_rows_at("short\n\n", 20), 2);
        assert_eq!(visual_rows_at(&format!("{}\n", "x".repeat(25)), 10), 3);
        assert_eq!(
            visual_rows_at(
                "before \u{1b}]8;;https://kizunasync.com\u{1b}\\word\u{1b}]8;;\u{1b}\\\n",
                80
            ),
            1
        );
    }

    #[test]
    fn a_prompt_frame_counts_wrapped_rows() {
        let cols = 20;
        let middle = format!("\u{1b}[31m{}\u{1b}[0m", "x".repeat(cols * 5 / 2));
        let frame = format!("first\n{middle}\nlast\n");
        assert_eq!(visual_rows_at(&frame, cols), 1 + 3 + 1);
    }
}
