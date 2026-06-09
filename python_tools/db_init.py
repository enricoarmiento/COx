import psycopg2
import sys

def main():
    db_url = "postgres://postgres.nciaamszrerqtjpvutts:yIwkGwe7YTgQS1eu@aws-1-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require"
    
    sql = """
    -- Create beds table
    CREATE TABLE IF NOT EXISTS beds (
        id TEXT PRIMARY KEY,
        patient_name TEXT,
        patient_surname TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
    );

    -- Create measurements table
    CREATE TABLE IF NOT EXISTS measurements (
        id BIGSERIAL PRIMARY KEY,
        bed_id TEXT REFERENCES beds(id) ON DELETE CASCADE,
        map DOUBLE PRECISION NOT NULL,
        scto2 DOUBLE PRECISION NOT NULL,
        cox DOUBLE PRECISION,
        timestamp_s INTEGER NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
    );

    -- Disable RLS to allow direct client-side operations via Supabase Anon Client
    ALTER TABLE beds DISABLE ROW LEVEL SECURITY;
    ALTER TABLE measurements DISABLE ROW LEVEL SECURITY;

    -- Initialize the 6 beds
    INSERT INTO beds (id, patient_name, patient_surname)
    VALUES 
        ('letto_1', NULL, NULL),
        ('letto_2', NULL, NULL),
        ('letto_3', NULL, NULL),
        ('letto_4', NULL, NULL),
        ('letto_5', NULL, NULL),
        ('letto_6', NULL)
    ON CONFLICT (id) DO NOTHING;
    """

    print("Connecting to Supabase PostgreSQL...")
    try:
        conn = psycopg2.connect(db_url)
        cur = conn.cursor()
        print("Executing table creation and initialization SQL...")
        cur.execute(sql)
        conn.commit()
        cur.close()
        conn.close()
        print("Database initialized successfully!")
    except Exception as e:
        print(f"Error initializing database: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
