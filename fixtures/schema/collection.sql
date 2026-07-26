-- Схема коллекции FLibrary.
--
-- ВНИМАНИЕ: файл сгенерирован из FLibrary (heimdallr/books):
--   src/home/inpx/resources/data/CreateCollection.json
--   src/home/inpx/resources/data/UpdateCollection.json
-- Править руками не нужно: перегенерировать `pnpm fixtures:schema`.
-- Используется только генератором фикстур. Продовая коллекция создаётся
-- самой FLibrary при импорте inpx.

-- === Таблицы и FTS-индексы (CreateCollection.json) ===

CREATE TABLE Annotations (
	BookID INTEGER NOT NULL PRIMARY KEY REFERENCES Books (BookID) ON DELETE CASCADE,
	Text   VARCHAR (10240) NOT NULL
);

CREATE TABLE Author_List (
	AuthorID INTEGER NOT NULL,
	BookID   INTEGER NOT NULL,
	OrdNum   INTEGER NOT NULL DEFAULT(0)
);

CREATE TABLE Authors (
	AuthorID   INTEGER NOT NULL,
	LastName   VARCHAR(128),
	FirstName  VARCHAR(128),
	MiddleName VARCHAR(128),
	SearchName VARCHAR(128),
	Flags	   INTEGER NOT NULL DEFAULT(0),
	IsDeleted  INTEGER NOT NULL DEFAULT(0)
);

CREATE TABLE Books (
	BookID      INTEGER NOT NULL,
	LibID       VARCHAR(200),
	Title       VARCHAR(200),
	UpdateDate  VARCHAR(23),
	LibRate     INTEGER,
	Lang        VARCHAR(3),
	Year        INTEGER,
	FolderID    INTEGER NOT NULL,
   FileName    VARCHAR(200) NOT NULL,
	Ext         VARCHAR(10),
	BookSize    INTEGER,
	UpdateID    INTEGER,
	IsDeleted   INTEGER NOT NULL DEFAULT 0,
	SourceLib   VARCHAR(15),
	SearchTitle VARCHAR(200)
);

CREATE TABLE Books_User (
	BookID    INTEGER NOT NULL PRIMARY KEY,
	IsDeleted INTEGER,
	UserRate  INTEGER,
	Lang      VARCHAR (3),
	CreatedAt DATETIME,
		FOREIGN KEY (BookID) REFERENCES Books (BookID) ON DELETE CASCADE
);

CREATE TABLE Compilation_List (
	CompilationID INTEGER REFERENCES Compilations (CompilationID) ON DELETE CASCADE NOT NULL,
	BookId        INTEGER REFERENCES Books        (BookID)        ON DELETE CASCADE NOT NULL,
	Part          INTEGER NOT NULL
);

CREATE TABLE Compilations (
	CompilationID INTEGER PRIMARY KEY NOT NULL,
	BookId        INTEGER REFERENCES Books (BookID) ON DELETE CASCADE NOT NULL,
	Title         VARCHAR (10240),
	Covered       INTEGER NOT NULL DEFAULT(0)
);

CREATE TABLE Export_List_User (
	BookID     INTEGER  NOT NULL,
	ExportType INTEGER  NOT NULL,
	CreatedAt  DATETIME NOT NULL
);

CREATE TABLE Folders (
	FolderID    INTEGER NOT NULL,
	FolderTitle VARCHAR(200) NOT NULL,
	IsDeleted   INTEGER NOT NULL DEFAULT(0)
);

CREATE TABLE Genre_List (
	GenreCode VARCHAR(20) NOT NULL,
	BookID    INTEGER NOT NULL,
	OrdNum    INTEGER NOT NULL DEFAULT(0) 
);

CREATE TABLE Genres (
	GenreCode  VARCHAR(20) NOT NULL,
	ParentCode VARCHAR(20),
	FB2Code    VARCHAR(20),
	GenreAlias VARCHAR(50),
	GenreTitle VARCHAR(50),
	Flags      INTEGER NOT NULL DEFAULT(0),
	IsDeleted  INTEGER NOT NULL DEFAULT(0)
);

CREATE TABLE Groups_List_User (
	GroupID   INTEGER  NOT NULL,
	ObjectID  INTEGER  NOT NULL,
	CreatedAt DATETIME,
		FOREIGN KEY (GroupID) REFERENCES Groups_User (GroupID) ON DELETE CASCADE
);

CREATE TABLE Groups_User (
	GroupID   INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	Title     VARCHAR(150) NOT NULL UNIQUE,
	CreatedAt DATETIME,
	IsDeleted INTEGER NOT NULL DEFAULT(0)
);

CREATE TABLE Inpx (
	Folder VARCHAR (200) NOT NULL,
	File   VARCHAR (200) NOT NULL,
	Hash   VARCHAR (50)  NOT NULL
);

CREATE TABLE Keyword_List (
	KeywordID INTEGER NOT NULL,
	BookID    INTEGER NOT NULL,
	OrdNum    INTEGER NOT NULL DEFAULT(0)
);

CREATE TABLE Keywords (
	KeywordID    INTEGER NOT NULL,
	KeywordTitle VARCHAR(150),
	SearchTitle  VARCHAR(150),
	Flags        INTEGER NOT NULL DEFAULT(0),
	IsDeleted    INTEGER NOT NULL DEFAULT(0)
);

CREATE TABLE Languages (
	LanguageCode VARCHAR(3) NOT NULL,
	Flags        INTEGER NOT NULL DEFAULT(0)
);

CREATE TABLE Reviews (
	BookID INTEGER NOT NULL,
	Folder VARCHAR(10) NOT NULL
);

CREATE TABLE Searches_User (
	SearchID  INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	Title     VARCHAR(150) NOT NULL UNIQUE,
	CreatedAt DATETIME
);

CREATE TABLE Series (
	SeriesID    INTEGER NOT NULL,
	SeriesTitle VARCHAR(80),
	SearchTitle VARCHAR(80),
	Flags       INTEGER NOT NULL DEFAULT(0),
	IsDeleted   INTEGER NOT NULL DEFAULT(0)
);

CREATE TABLE Series_List (
	SeriesID  INTEGER NOT NULL,
	BookID    INTEGER NOT NULL,
	SeqNumber INTEGER,
	OrdNum    INTEGER NOT NULL DEFAULT(0)
);

CREATE TABLE Settings (
	SettingID    INTEGER NOT NULL PRIMARY KEY,
	SettingValue BLOB
);

CREATE TABLE Updates (
	UpdateID    INTEGER NOT NULL,
	UpdateTitle INTEGER NOT NULL,
	ParentID    INTEGER NOT NULL,
	IsDeleted   INTEGER NOT NULL DEFAULT(0)
);

CREATE VIRTUAL TABLE Annotations_Search USING fts5(Text, content=Annotations, content_rowid=BookID);

CREATE VIRTUAL TABLE Authors_Search USING fts5(LastName, FirstName, MiddleName, content=Authors, content_rowid=AuthorID);

CREATE VIRTUAL TABLE Books_Search USING fts5(Title, content=Books, content_rowid=BookID);

CREATE VIRTUAL TABLE Compilations_Search USING fts5(Title, content=Compilations, content_rowid=CompilationID);

CREATE VIRTUAL TABLE Series_Search USING fts5(SeriesTitle, content=Series, content_rowid=SeriesID);

-- === Индексы и представления (UpdateCollection.json) ===

CREATE UNIQUE INDEX UIX_Folders_PrimaryKey ON Folders (FolderID);

CREATE INDEX IX_Folders_FolderTitle ON Folders(FolderTitle COLLATE NOCASE);

CREATE UNIQUE INDEX UIX_Series_PrimaryKey ON Series (SeriesID);

CREATE UNIQUE INDEX UIX_Series_List_PrimaryKey ON Series_List (SeriesID, BookID);

CREATE INDEX IX_Series_List_BookID_SeriesID ON Series_List (BookID, SeriesID);

CREATE INDEX IX_Series_SearchTitle ON Series(SearchTitle COLLATE NOCASE);

CREATE UNIQUE INDEX UIX_GenresPrimaryKey ON Genres (GenreCode);

CREATE UNIQUE INDEX IX_Genres_ParentCode_GenreCode ON Genres (ParentCode, GenreCode);

CREATE UNIQUE INDEX UIX_Authors_PrimaryKey ON Authors (AuthorID);

CREATE INDEX IX_Authors_SearchName ON Authors(SearchName COLLATE NOCASE);

CREATE UNIQUE INDEX UIX_Books_PrimaryKey ON Books (BookID);

CREATE INDEX IX_Books_FolderID ON Books (FolderID);

CREATE INDEX IX_Books_UpdateID ON Books (UpdateID);

CREATE INDEX IX_Books_FileName ON Books (FileName);

CREATE INDEX IX_Books_Lang ON Books (Lang);

CREATE INDEX IX_Books_Year ON Books (Year);

CREATE INDEX IX_Books_SearchTitle ON Books (SearchTitle COLLATE NOCASE);

CREATE UNIQUE INDEX UIX_Genre_List_PrimaryKey ON Genre_List (BookID, GenreCode);

CREATE INDEX IX_GenreList_GenreCode_BookID ON Genre_List (GenreCode, BookID);

CREATE UNIQUE INDEX UIX_Author_List_PrimaryKey ON Author_List (BookID, AuthorID);

CREATE INDEX IX_AuthorList_AuthorID_BookID ON Author_List (AuthorID, BookID);

CREATE UNIQUE INDEX UIX_Groups_List_User_PrimaryKey ON Groups_List_User (GroupID, ObjectID);

CREATE INDEX IX_Groups_List_User_ObjectID ON Groups_List_User (ObjectID);

CREATE UNIQUE INDEX UIX_Languages_PrimaryKey ON Languages (LanguageCode);

CREATE UNIQUE INDEX UIX_Keywords_PrimaryKey ON Keywords (KeywordID);

CREATE UNIQUE INDEX UIX_Keyword_List_PrimaryKey ON Keyword_List (KeywordID, BookID);

CREATE INDEX IX_Keyword_List_BookID_KeywordID ON Keyword_List (BookID, KeywordID);

CREATE INDEX IX_Keywords_SearchTitle ON Keywords(SearchTitle COLLATE NOCASE);

CREATE INDEX IX_ExportListUser_BookID ON Export_List_User (BookID);

CREATE UNIQUE INDEX UIX_Inpx_PrimaryKey ON Inpx (Folder COLLATE NOCASE, File COLLATE NOCASE);

CREATE UNIQUE INDEX UIX_Update_PrimaryKey ON Updates (UpdateID);

CREATE INDEX IX_Update_ParentID ON Updates (ParentID);

CREATE UNIQUE INDEX UIX_Reviews_PrimaryKey ON Reviews (BookID, Folder);

CREATE INDEX IX_ExportListUser_ExportType_CreatedAt ON Export_List_User (ExportType, CreatedAt DESC);

CREATE INDEX IF NOT EXISTS IX_Books_User_UserRate ON Books_User (UserRate);

CREATE VIEW Books_View (
	  BookID,   LibID,   Title,   UpdateDate,   LibRate,   Lang,   Year,   FolderID,                        FileName,   BookSize,   UpdateID,                                        IsDeleted,    UserRate,   SourceLib,   SearchTitle,               BaseFileName,   Ext
) AS SELECT 
	b.BookID, b.LibID, b.Title, b.UpdateDate, b.LibRate, b.Lang, b.Year, b.FolderID, b.FileName || b.Ext AS FileName, b.BookSize, b.UpdateID, coalesce(bu.IsDeleted, b.IsDeleted) AS IsDeleted, bu.UserRate, b.SourceLib, b.SearchTitle, b.FileName AS BaseFileName, b.Ext
FROM Books b
LEFT JOIN Books_User bu ON bu.BookID = b.BookID;

CREATE VIEW Groups_List_User_View (
	        GroupID,    BookID
) AS 
SELECT glu.GroupID,  b.BookID FROM Groups_List_User glu JOIN Books b         ON b.BookID     = glu.ObjectID UNION
SELECT glu.GroupID, al.BookID FROM Groups_List_User glu JOIN Author_List al  ON al.AuthorID  = glu.ObjectID UNION
SELECT glu.GroupID, sl.BookID FROM Groups_List_User glu JOIN Series_List sl  ON sl.SeriesID  = glu.ObjectID UNION
SELECT glu.GroupID, kl.BookID FROM Groups_List_User glu JOIN Keyword_List kl ON kl.KeywordID = glu.ObjectID;
