//! Key loop for the wizard questions that have to step backward.
//!
//! cliclack's own select ignores Backspace. These prompts draw with the same
//! theme and treat Backspace on an empty field as "previous question".
//!
//! Keys are read with `read_key_raw`: `read_key` raises SIGINT on Ctrl+C,
//! which kills the process before a cancel can close the wizard on exit 0.
//! While a question is drawn the terminal would still turn Ctrl+C into SIGINT,
//! so [`Held`] keeps it a key from the question's first frame to its answer.

use std::io::{self, Write};

use cliclack::{StringCursor, Theme, ThemeState};
use console::{Key, Term};

use super::{BackKey, PromptError};
use crate::interrupt::KeysAtPrompt;
use crate::wizard_theme::{KeyHint, VermilionTheme, set_key_hint};

pub(super) enum Stroke<T> {
    Value(T),
    Back,
}

/// What Backspace does on a list.
#[derive(Debug, PartialEq, Eq)]
enum ListBackspace {
    /// It deletes the last character of the filter.
    Filter,
    /// It answers [`Stroke::Back`].
    Back,
    /// Nothing: no step lies behind the list.
    Nothing,
}

fn list_backspace(filter: bool, query: &str, back: BackKey) -> ListBackspace {
    if filter && !query.is_empty() {
        return ListBackspace::Filter;
    }

    match back {
        BackKey::Honoured => ListBackspace::Back,
        BackKey::Ignored => ListBackspace::Nothing,
    }
}

/// What a key did to a typed field.
#[derive(Debug, PartialEq, Eq)]
enum LineKey {
    /// Esc or Ctrl+C.
    Cancel,
    /// Backspace on the empty field.
    Back,
    /// Enter.
    Submit,
    /// A character typed or deleted.
    Edited,
    /// A key the field does not use.
    Ignored,
}

fn line_key(value: &mut StringCursor, key: &Key) -> LineKey {
    match key {
        Key::Escape | Key::CtrlC => LineKey::Cancel,
        Key::Backspace if value.is_empty() => LineKey::Back,
        Key::Backspace => {
            value.delete_left();
            LineKey::Edited
        }
        Key::Enter => LineKey::Submit,
        Key::Char(ch) if !ch.is_ascii_control() => {
            value.insert(*ch);
            LineKey::Edited
        }
        _ => LineKey::Ignored,
    }
}

/// The terminal as a question holds it: Ctrl+C a key and the cursor hidden.
/// Dropping it shows the cursor, then gives the keys back.
struct Held {
    _keys: KeysAtPrompt,
}

impl Drop for Held {
    fn drop(&mut self) {
        let _ = Term::stderr().show_cursor();
    }
}

fn hold(term: &Term) -> Result<Held, PromptError> {
    let keys = KeysAtPrompt::hold();
    term.hide_cursor().map_err(|error| io_error(&error))?;

    Ok(Held { _keys: keys })
}

pub(super) fn choose<T>(
    title: &str,
    items: &[(T, String, String)],
    initial: &T,
    filter: bool,
    back: BackKey,
) -> Result<Stroke<T>, PromptError>
where
    T: Clone + Eq,
{
    if items.is_empty() {
        return Err(PromptError::Backend("no choices".to_owned()));
    }
    let mut term = Term::stderr();
    if !term.is_term() {
        return Err(PromptError::NotInteractive);
    }
    let mut cursor = items
        .iter()
        .position(|(value, _, _)| value == initial)
        .unwrap_or(0);
    let mut query = String::new();
    let mut shown = 0_usize;
    let _held = hold(&term)?;

    loop {
        let visible = visible_items(items, filter, &query);
        if visible.is_empty() {
            cursor = 0;
        } else if cursor >= visible.len() {
            cursor = visible.len() - 1;
        }
        let listed = Listed {
            visible: &visible,
            cursor,
            query: &query,
            filter,
            back,
        };
        shown = paint(&mut term, shown, &select_frame(title, items, &listed, None))?;

        match term.read_key_raw() {
            Ok(Key::Escape | Key::CtrlC) => return Err(PromptError::Cancelled),
            Ok(Key::Backspace) => match list_backspace(filter, &query, back) {
                ListBackspace::Filter => {
                    query.pop();
                    cursor = 0;
                }
                ListBackspace::Back => {
                    clear_frame(&mut term, shown)?;
                    return Ok(Stroke::Back);
                }
                ListBackspace::Nothing => {}
            },
            Ok(Key::Enter) => {
                let Some(index) = visible.get(cursor).copied() else {
                    continue;
                };
                let chosen = select_frame(title, items, &listed, Some(index));
                paint(&mut term, shown, &chosen)?;
                crate::wizard_theme::commit_text(&chosen);
                return Ok(Stroke::Value(items[index].0.clone()));
            }
            Ok(Key::ArrowUp | Key::ArrowLeft | Key::Char('k' | 'h')) => {
                cursor = cursor.saturating_sub(1);
            }
            Ok(Key::ArrowDown | Key::ArrowRight | Key::Char('j' | 'l')) => {
                if !visible.is_empty() {
                    cursor = (cursor + 1).min(visible.len() - 1);
                }
            }
            Ok(Key::Char(ch)) if filter && !ch.is_ascii_control() => {
                query.push(ch);
                cursor = 0;
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                return Err(PromptError::Cancelled);
            }
            Err(error) => return Err(io_error(&error)),
        }
    }
}

pub(super) fn read_line(
    title: &str,
    placeholder: &str,
    default_on_empty: Option<&str>,
    masked: bool,
    validate: impl Fn(&str) -> Result<(), String>,
) -> Result<Stroke<String>, PromptError> {
    line(
        title,
        placeholder,
        StringCursor::default(),
        default_on_empty,
        masked,
        validate,
    )
}

/// A typed field that opens holding `text` to edit. The emptied field shows
/// `placeholder`, and Enter on it submits the empty answer.
pub(super) fn edit_line(
    title: &str,
    placeholder: &str,
    text: &str,
    validate: impl Fn(&str) -> Result<(), String>,
) -> Result<Stroke<String>, PromptError> {
    line(title, placeholder, opened_on(text), None, false, validate)
}

/// `text` with the cursor after its last character.
fn opened_on(text: &str) -> StringCursor {
    let mut value = StringCursor::default();
    for ch in text.chars() {
        value.insert(ch);
    }

    value
}

fn line(
    title: &str,
    placeholder: &str,
    mut value: StringCursor,
    default_on_empty: Option<&str>,
    masked: bool,
    validate: impl Fn(&str) -> Result<(), String>,
) -> Result<Stroke<String>, PromptError> {
    let mut term = Term::stderr();
    if !term.is_term() {
        return Err(PromptError::NotInteractive);
    }
    let mut error: Option<String> = None;
    let mut shown = 0_usize;
    let _held = hold(&term)?;

    loop {
        let state = match &error {
            Some(message) => ThemeState::Error(message.clone()),
            None => ThemeState::Active,
        };
        let frame = line_frame(title, placeholder, &value, masked, &state);
        shown = paint(&mut term, shown, &frame)?;

        let key = match term.read_key_raw() {
            Ok(key) => key,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                return Err(PromptError::Cancelled);
            }
            Err(error) => return Err(io_error(&error)),
        };
        match line_key(&mut value, &key) {
            LineKey::Cancel => return Err(PromptError::Cancelled),
            LineKey::Back => {
                clear_frame(&mut term, shown)?;
                return Ok(Stroke::Back);
            }
            LineKey::Edited => error = None,
            LineKey::Ignored => {}
            LineKey::Submit => {
                let mut submitted = value.to_string();
                if submitted.is_empty()
                    && let Some(default) = default_on_empty
                {
                    default.clone_into(&mut submitted);
                }
                if let Err(message) = validate(&submitted) {
                    error = Some(message);
                    continue;
                }
                if submitted.trim().eq_ignore_ascii_case("back") {
                    clear_frame(&mut term, shown)?;
                    return Ok(Stroke::Back);
                }
                let mut kept = StringCursor::default();
                kept.extend(&submitted);
                let frame = line_frame(title, placeholder, &kept, masked, &ThemeState::Submit);
                paint(&mut term, shown, &frame)?;
                crate::wizard_theme::commit_text(&frame);
                return Ok(Stroke::Value(submitted));
            }
        }
    }
}

fn visible_items<T>(items: &[(T, String, String)], filter: bool, query: &str) -> Vec<usize> {
    let needle = query.trim().to_lowercase();
    items
        .iter()
        .enumerate()
        .filter(|(_, (_, label, _))| {
            !filter || needle.is_empty() || label.to_lowercase().contains(&needle)
        })
        .map(|(index, _)| index)
        .collect()
}

pub(super) fn confirm(title: &str, default: bool) -> Result<Stroke<bool>, PromptError> {
    let mut term = Term::stderr();
    if !term.is_term() {
        return Err(PromptError::NotInteractive);
    }
    let mut yes = default;
    let mut shown = 0_usize;
    let _held = hold(&term)?;

    loop {
        shown = paint(&mut term, shown, &confirm_frame(title, yes, false))?;
        match term.read_key_raw() {
            Ok(Key::Escape | Key::CtrlC) => return Err(PromptError::Cancelled),
            Ok(Key::Backspace) => {
                clear_frame(&mut term, shown)?;
                return Ok(Stroke::Back);
            }
            Ok(Key::Enter) => {
                let frame = confirm_frame(title, yes, true);
                paint(&mut term, shown, &frame)?;
                crate::wizard_theme::commit_text(&frame);
                return Ok(Stroke::Value(yes));
            }
            Ok(Key::Char('y' | 'Y')) => {
                let frame = confirm_frame(title, true, true);
                paint(&mut term, shown, &frame)?;
                crate::wizard_theme::commit_text(&frame);
                return Ok(Stroke::Value(true));
            }
            Ok(Key::Char('n' | 'N')) => {
                let frame = confirm_frame(title, false, true);
                paint(&mut term, shown, &frame)?;
                crate::wizard_theme::commit_text(&frame);
                return Ok(Stroke::Value(false));
            }
            Ok(Key::ArrowLeft | Key::ArrowRight | Key::Char('h' | 'l')) => yes = !yes,
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                return Err(PromptError::Cancelled);
            }
            Err(error) => return Err(io_error(&error)),
        }
    }
}

/// Space on the row under the cursor: it flips, unless the row is locked.
fn toggle(on: &mut [bool], locked: &[bool], cursor: usize) {
    if locked.get(cursor).copied().unwrap_or(false) {
        return;
    }

    if let Some(flag) = on.get_mut(cursor) {
        *flag = !*flag;
    }
}

/// A checkbox list. A row in `locked` is listed but never checked.
pub(super) fn choose_multi(
    title: &str,
    items: &[(String, String, String)],
    checked: &[String],
    locked: &[String],
) -> Result<Stroke<Vec<String>>, PromptError> {
    if items.is_empty() {
        return Ok(Stroke::Value(Vec::new()));
    }
    let mut term = Term::stderr();
    if !term.is_term() {
        return Err(PromptError::NotInteractive);
    }
    let locked: Vec<bool> = items
        .iter()
        .map(|(value, _, _)| locked.iter().any(|kept_out| kept_out == value))
        .collect();
    let mut on: Vec<bool> = items
        .iter()
        .zip(&locked)
        .map(|((value, _, _), locked)| !locked && checked.iter().any(|chosen| chosen == value))
        .collect();
    let mut cursor = 0_usize;
    let mut shown = 0_usize;
    let _held = hold(&term)?;

    loop {
        shown = paint(
            &mut term,
            shown,
            &multi_frame(title, items, &on, cursor, false),
        )?;
        match term.read_key_raw() {
            Ok(Key::Escape | Key::CtrlC) => return Err(PromptError::Cancelled),
            Ok(Key::Backspace) => {
                clear_frame(&mut term, shown)?;
                return Ok(Stroke::Back);
            }
            Ok(Key::Char(' ')) => toggle(&mut on, &locked, cursor),
            Ok(Key::Enter) => {
                let frame = multi_frame(title, items, &on, cursor, true);
                paint(&mut term, shown, &frame)?;
                crate::wizard_theme::commit_text(&frame);
                let chosen = items
                    .iter()
                    .zip(&on)
                    .filter(|(_, selected)| **selected)
                    .map(|((value, _, _), _)| value.clone())
                    .collect();
                return Ok(Stroke::Value(chosen));
            }
            Ok(Key::ArrowUp | Key::ArrowLeft | Key::Char('k' | 'h')) => {
                cursor = cursor.saturating_sub(1);
            }
            Ok(Key::ArrowDown | Key::ArrowRight | Key::Char('j' | 'l')) => {
                cursor = (cursor + 1).min(items.len() - 1);
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                return Err(PromptError::Cancelled);
            }
            Err(error) => return Err(io_error(&error)),
        }
    }
}

fn confirm_frame(title: &str, yes: bool, submit: bool) -> String {
    set_key_hint(KeyHint::Confirm, BackKey::Honoured);
    let theme = VermilionTheme;
    let state = if submit {
        ThemeState::Submit
    } else {
        ThemeState::Active
    };
    let mut frame = theme.format_header(&state, title);
    frame.push_str(&theme.format_confirm(&state, yes));
    frame.push_str(&theme.format_footer_with_message(&state, ""));
    frame
}

fn multi_frame(
    title: &str,
    items: &[(String, String, String)],
    on: &[bool],
    cursor: usize,
    submit: bool,
) -> String {
    set_key_hint(KeyHint::Multi, BackKey::Honoured);
    let theme = VermilionTheme;
    let state = if submit {
        ThemeState::Submit
    } else {
        ThemeState::Active
    };
    let mut frame = theme.format_header(&state, title);
    for (index, (_, label, hint)) in items.iter().enumerate() {
        let selected = on[index];
        if submit && !selected {
            continue;
        }
        frame.push_str(&theme.format_multiselect_item(
            &state,
            selected,
            index == cursor,
            label,
            hint,
        ));
    }
    frame.push_str(&theme.format_footer_with_message(&state, ""));
    frame
}

/// A list as one key left it.
struct Listed<'a> {
    /// The rows the filter keeps, as indices into the items.
    visible: &'a [usize],
    cursor: usize,
    query: &'a str,
    filter: bool,
    back: BackKey,
}

fn select_frame<T>(
    title: &str,
    items: &[(T, String, String)],
    listed: &Listed<'_>,
    submit: Option<usize>,
) -> String {
    set_key_hint(KeyHint::List, listed.back);
    let theme = VermilionTheme;
    let state = if submit.is_some() {
        ThemeState::Submit
    } else {
        ThemeState::Active
    };
    let mut frame = theme.format_header(&state, title);
    if listed.filter && submit.is_none() {
        let mut typed = StringCursor::default();
        typed.extend(listed.query);
        frame.push_str(&theme.format_input(&state, &typed));
    }
    for (shown, index) in listed.visible.iter().copied().enumerate() {
        let selected = submit.map_or(shown == listed.cursor, |chosen| chosen == index);
        if submit.is_some() && !selected {
            continue;
        }
        frame.push_str(&theme.format_select_item(
            &state,
            selected,
            &items[index].1,
            &items[index].2,
        ));
    }
    frame.push_str(&theme.format_footer_with_message(&state, ""));
    frame
}

fn line_frame(
    title: &str,
    placeholder: &str,
    value: &StringCursor,
    masked: bool,
    state: &ThemeState,
) -> String {
    set_key_hint(KeyHint::Text, BackKey::Honoured);
    let theme = VermilionTheme;
    let shown = masked_cursor(value, masked);
    let mut frame = theme.format_header(state, title);
    if value.is_empty() && !matches!(state, ThemeState::Submit) {
        let mut hint = StringCursor::default();
        hint.extend(placeholder);
        frame.push_str(&theme.format_placeholder(state, &hint));
    } else {
        frame.push_str(&theme.format_input(state, &shown));
    }
    let message = match state {
        ThemeState::Error(message) => message.as_str(),
        _ => "",
    };
    frame.push_str(&theme.format_footer_with_message(state, message));
    frame
}

fn masked_cursor(value: &StringCursor, masked: bool) -> StringCursor {
    if !masked {
        return value.clone();
    }
    let mut bullets = StringCursor::default();
    bullets.extend(&"•".repeat(value.to_string().chars().count()));
    bullets
}

fn clear_frame(term: &mut Term, lines: usize) -> Result<(), PromptError> {
    if lines > 0 {
        term.clear_last_lines(lines)
            .map_err(|error| io_error(&error))?;
    }
    term.flush().map_err(|error| io_error(&error))
}

fn paint(term: &mut Term, previous: usize, frame: &str) -> Result<usize, PromptError> {
    if previous > 0 {
        term.clear_last_lines(previous)
            .map_err(|error| io_error(&error))?;
    }
    term.write_all(frame.as_bytes())
        .map_err(|error| io_error(&error))?;
    term.flush().map_err(|error| io_error(&error))?;
    Ok(crate::wizard_theme::visual_rows(frame))
}

pub(super) fn io_error(error: &io::Error) -> PromptError {
    match error.kind() {
        io::ErrorKind::Interrupted => PromptError::Cancelled,
        io::ErrorKind::NotConnected => PromptError::NotInteractive,
        _ => PromptError::Backend(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backspace_deletes_a_character_and_on_the_empty_field_steps_back() {
        let mut value = opened_on("ab");

        assert_eq!(line_key(&mut value, &Key::Backspace), LineKey::Edited);
        assert_eq!(value.to_string(), "a");
        assert_eq!(line_key(&mut value, &Key::Backspace), LineKey::Edited);
        assert!(value.is_empty());
        assert_eq!(line_key(&mut value, &Key::Backspace), LineKey::Back);
    }

    #[test]
    fn ctrl_c_and_esc_cancel_a_typed_field_whatever_it_holds() {
        for text in ["", "local"] {
            let mut value = opened_on(text);

            assert_eq!(line_key(&mut value, &Key::CtrlC), LineKey::Cancel);
            assert_eq!(line_key(&mut value, &Key::Escape), LineKey::Cancel);
            assert_eq!(value.to_string(), text);
        }
    }

    /// A field opened on text shows that text, which Backspace deletes one
    /// character at a time; the emptied field shows its placeholder again and
    /// Enter submits it empty.
    #[test]
    fn a_field_opened_on_text_edits_it_down_to_an_empty_answer() {
        let frame = |value: &StringCursor| {
            line_frame(
                "cap",
                "empty = unlimited",
                value,
                false,
                &ThemeState::Active,
            )
        };
        let mut value = opened_on("500");

        assert_eq!(value.to_string(), "500");
        let opened = frame(&value);
        assert!(opened.contains("500"), "{opened}");
        assert!(!opened.contains("empty = unlimited"), "{opened}");
        for _ in 0..3 {
            assert_eq!(line_key(&mut value, &Key::Backspace), LineKey::Edited);
        }
        assert!(value.is_empty());
        let emptied = frame(&value);
        assert!(emptied.contains("empty = unlimited"), "{emptied}");
        assert_eq!(line_key(&mut value, &Key::Enter), LineKey::Submit);
        assert_eq!(value.to_string(), "");
    }

    /// The push field opens on the project's cap, three Backspaces empty it,
    /// and Enter saves no cap: the policy it answers carries no batch limit.
    #[test]
    fn three_backspaces_on_a_three_digit_cap_save_no_cap() {
        use crate::config::{MaxBatchSize, ProjectSettings};

        let current = ProjectSettings {
            max_batch_size: Some(MaxBatchSize::Mutations(500)),
            ..ProjectSettings::default()
        };
        let mut value = opened_on("500");
        for _ in 0..3 {
            assert_eq!(line_key(&mut value, &Key::Backspace), LineKey::Edited);
        }

        assert_eq!(line_key(&mut value, &Key::Enter), LineKey::Submit);
        let answered = super::super::cliclack::push_policy_from(&value.to_string(), &current);
        assert_eq!(answered.max_batch_size, Some(MaxBatchSize::Unlimited));
        assert_eq!(
            crate::config_sql::settings_sql_for(&answered)
                .map(|written| written.contains("max_batch_size = null")),
            Some(true)
        );
    }

    #[test]
    fn a_typed_character_is_kept_and_enter_submits() {
        let mut value = opened_on("");

        assert_eq!(line_key(&mut value, &Key::Char('4')), LineKey::Edited);
        assert_eq!(line_key(&mut value, &Key::Enter), LineKey::Submit);
        assert_eq!(value.to_string(), "4");
    }

    #[test]
    fn space_flips_a_row_but_never_a_locked_one() {
        let locked = [false, true];
        let mut on = [false, false];

        toggle(&mut on, &locked, 0);
        toggle(&mut on, &locked, 1);
        assert_eq!(on, [true, false]);
        toggle(&mut on, &locked, 0);
        assert_eq!(on, [false, false]);
    }

    #[test]
    fn backspace_on_a_list_edits_its_filter_then_steps_back_unless_it_is_ignored() {
        assert_eq!(
            list_backspace(true, "to", BackKey::Honoured),
            ListBackspace::Filter
        );
        assert_eq!(
            list_backspace(true, "", BackKey::Honoured),
            ListBackspace::Back
        );
        assert_eq!(
            list_backspace(false, "", BackKey::Honoured),
            ListBackspace::Back
        );
        assert_eq!(
            list_backspace(true, "to", BackKey::Ignored),
            ListBackspace::Filter
        );
        assert_eq!(
            list_backspace(false, "", BackKey::Ignored),
            ListBackspace::Nothing
        );
    }
}
