use crate::{Error, Result};
use std::marker::PhantomData;
use turso::Value;

/// A SQL result value decoded without implicit text/numeric coercion.
pub trait FromValue: Sized {
    /// Decode a single result value.
    ///
    /// # Errors
    /// Returns a type or range error.
    fn from_value(value: Value) -> Result<Self>;
}
fn wrong_type() -> Error {
    Error::Value("result column has the wrong type".into())
}
impl FromValue for Value {
    fn from_value(value: Value) -> Result<Self> {
        Ok(value)
    }
}
impl FromValue for String {
    fn from_value(value: Value) -> Result<Self> {
        if let Value::Text(value) = value {
            Ok(value)
        } else {
            Err(wrong_type())
        }
    }
}
impl FromValue for Vec<u8> {
    fn from_value(value: Value) -> Result<Self> {
        if let Value::Blob(value) = value {
            Ok(value)
        } else {
            Err(wrong_type())
        }
    }
}
impl FromValue for i64 {
    fn from_value(value: Value) -> Result<Self> {
        if let Value::Integer(value) = value {
            Ok(value)
        } else {
            Err(wrong_type())
        }
    }
}
impl FromValue for bool {
    fn from_value(value: Value) -> Result<Self> {
        Ok(i64::from_value(value)? != 0)
    }
}
// SQLite's numeric read contract permits conversion from INTEGER to REAL.
#[allow(clippy::cast_precision_loss)]
impl FromValue for f64 {
    fn from_value(value: Value) -> Result<Self> {
        match value {
            Value::Real(value) => Ok(value),
            Value::Integer(value) => Ok(value as Self),
            _ => Err(wrong_type()),
        }
    }
}
impl<T: FromValue> FromValue for Option<T> {
    fn from_value(value: Value) -> Result<Self> {
        if value == Value::Null {
            Ok(None)
        } else {
            T::from_value(value).map(Some)
        }
    }
}
macro_rules! integers {
    ($($ty:ty),*) => {$(impl FromValue for $ty {
        fn from_value(value: Value) -> Result<Self> { Self::try_from(i64::from_value(value)?).map_err(|_| Error::Value("result integer is out of range".into())) }
    })*};
}
integers!(i8, i16, i32, isize, u8, u16, u32, u64, usize);

/// A zero-based result column index.
pub trait RowIndex {
    /// Validate and resolve the index.
    ///
    /// # Errors
    /// Returns an error for a negative index.
    fn index(self) -> Result<usize>;
}
impl RowIndex for usize {
    fn index(self) -> Result<usize> {
        Ok(self)
    }
}
impl RowIndex for i32 {
    fn index(self) -> Result<usize> {
        usize::try_from(self).map_err(|_| Error::Value("negative column index".into()))
    }
}

/// A row owned by a result cursor.
pub struct Row<'a> {
    row: turso::Row,
    marker: PhantomData<&'a ()>,
}
impl Row<'_> {
    pub(crate) fn new(row: turso::Row) -> Self {
        Self {
            row,
            marker: PhantomData,
        }
    }
    /// Decode one result column.
    ///
    /// # Errors
    /// Returns an invalid-index, type or range error.
    pub fn get<I: RowIndex, T: FromValue>(&self, index: I) -> Result<T> {
        T::from_value(self.row.get_value(index.index()?)?)
    }
}
macro_rules! tuple {
    ($($ty:ident:$index:literal),+) => {
        impl<$($ty: FromValue),+> TryFrom<&Row<'_>> for ($($ty,)+) {
            type Error = Error;
            fn try_from(row: &Row<'_>) -> Result<Self> { Ok(($(row.get::<_, $ty>($index)?,)+)) }
        }
    };
}
tuple!(A:0);
tuple!(A:0,B:1);
tuple!(A:0,B:1,C:2);
tuple!(A:0,B:1,C:2,D:3);
tuple!(A:0,B:1,C:2,D:3,E:4);
tuple!(A:0,B:1,C:2,D:3,E:4,F:5);
tuple!(A:0,B:1,C:2,D:3,E:4,F:5,G:6);
tuple!(A:0,B:1,C:2,D:3,E:4,F:5,G:6,H:7);
tuple!(A:0,B:1,C:2,D:3,E:4,F:5,G:6,H:7,I:8);
tuple!(A:0,B:1,C:2,D:3,E:4,F:5,G:6,H:7,I:8,J:9);
