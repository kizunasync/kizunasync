use crate::{Error, Result};
use turso::Value;

/// A value that can be bound to a SQL parameter.
pub trait ToSql {
    /// Convert a parameter without narrowing integers silently.
    ///
    /// # Errors
    /// Returns an error for an integer outside SQLite's signed 64-bit range.
    fn to_value(&self) -> Result<Value>;
}
impl<T: ToSql + ?Sized> ToSql for &T {
    fn to_value(&self) -> Result<Value> {
        (*self).to_value()
    }
}
impl ToSql for str {
    fn to_value(&self) -> Result<Value> {
        Ok(Value::Text(self.into()))
    }
}
impl ToSql for String {
    fn to_value(&self) -> Result<Value> {
        self.as_str().to_value()
    }
}
impl ToSql for bool {
    fn to_value(&self) -> Result<Value> {
        Ok(Value::Integer(i64::from(*self)))
    }
}
impl ToSql for f64 {
    fn to_value(&self) -> Result<Value> {
        Ok(Value::Real(*self))
    }
}
impl ToSql for Value {
    fn to_value(&self) -> Result<Value> {
        Ok(self.clone())
    }
}
impl ToSql for Vec<u8> {
    fn to_value(&self) -> Result<Value> {
        Ok(Value::Blob(self.clone()))
    }
}
impl<T: ToSql> ToSql for Option<T> {
    fn to_value(&self) -> Result<Value> {
        self.as_ref().map_or(Ok(Value::Null), ToSql::to_value)
    }
}

macro_rules! integers {
    ($($ty:ty),*) => {$(impl ToSql for $ty {
        fn to_value(&self) -> Result<Value> {
            i64::try_from(*self).map(Value::Integer).map_err(|_| Error::Value("parameter exceeds signed 64-bit range".into()))
        }
    })*};
}
integers!(i8, i16, i32, i64, isize, u8, u16, u32, u64, usize);

/// Positional parameters for a statement.
pub trait Params {
    /// Convert parameters before starting a statement.
    ///
    /// # Errors
    /// Returns the first conversion error.
    fn values(self) -> Result<Vec<Value>>;
}
impl Params for [(); 0] {
    fn values(self) -> Result<Vec<Value>> {
        Ok(Vec::new())
    }
}
impl Params for &[&dyn ToSql] {
    fn values(self) -> Result<Vec<Value>> {
        self.iter().map(ToSql::to_value).collect()
    }
}
impl<const N: usize> Params for &[&dyn ToSql; N] {
    fn values(self) -> Result<Vec<Value>> {
        self.as_slice().values()
    }
}
macro_rules! arrays {
    ($($n:literal),*) => {$(impl<T: ToSql> Params for [T; $n] {
        fn values(self) -> Result<Vec<Value>> { self.iter().map(ToSql::to_value).collect() }
    })*};
}
arrays!(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16);

/// Collect heterogeneous positional parameters without interpolating SQL.
#[macro_export]
macro_rules! params { ($($value:expr),* $(,)?) => { &[$(&$value as &dyn $crate::ToSql),*] }; }

/// Parameters provided by an iterator; conversion stays fallible.
pub struct IterParams<I>(I);
impl<I, T> Params for IterParams<I>
where
    I: IntoIterator<Item = T>,
    T: ToSql,
{
    fn values(self) -> Result<Vec<Value>> {
        self.0.into_iter().map(|value| value.to_value()).collect()
    }
}
/// Bind parameters from an iterator without panicking on conversion failure.
pub fn params_from_iter<I: IntoIterator>(values: I) -> IterParams<I> {
    IterParams(values)
}
