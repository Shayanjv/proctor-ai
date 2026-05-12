from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.ext.declarative import declarative_base
from config.settings import settings
from utils.logger import logger
import os

Base = declarative_base()

def get_database_url():
    """Get database URL based on configuration"""
    if settings.DB_TYPE.lower() == "sqlite":
        logger.info("Using SQLite database")
        return settings.SQLITE_URL
    
    if settings.DB_TYPE.lower() == "postgres" or settings.DB_TYPE.lower() == "postgresql":
        # Construct PostgreSQL URL
        return (
            f"postgresql://{settings.DB_USER}:{settings.DB_PASSWORD}"
            f"@{settings.DB_HOST}:{settings.DB_PORT}/{settings.DB_NAME}"
        )

    # Fallback to MySQL if specified (legacy support)
    if settings.DB_TYPE.lower() == "mysql":
        return (
            f"mysql+mysqlconnector://{settings.DB_USER}:{settings.DB_PASSWORD}"
            f"@{settings.DB_HOST}:{settings.DB_PORT}/{settings.DB_NAME}"
        )
            
    return settings.SQLITE_URL

def create_db_engine():
    """Create database engine with proper configuration"""
    db_url = get_database_url()
    connect_args = {}
    
    if db_url.startswith('sqlite'):
        connect_args["check_same_thread"] = False
    
    try:
        engine = create_engine(
            db_url,
            pool_pre_ping=True,
            pool_recycle=3600,
            pool_size=20,
            max_overflow=40,
            connect_args=connect_args
        )
        return engine
    except Exception as e:
        logger.error(f"Failed to create engine: {str(e)}")
        raise e
    return None

engine = create_db_engine()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def get_db():
    """Synchronous database session dependency"""
    db = SessionLocal()
    try:
        yield db
    finally:
        if db is not None:
            db.close()

def get_async_db():
    """Async database session dependency"""
    db = SessionLocal()
    try:
        yield db
    finally:
        if db is not None:
            db.close()
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
