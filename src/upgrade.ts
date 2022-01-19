import { readdir } from "fs/promises";
import mysql from "mysql2/promise";
import path from "path";
import { IMigrationFile, IMigrationFileInfo, CreatedStatus, DbQueryResult } from "./types";
import { convertFilename, handleExceptionLazy, successText, warningText } from "./utils";

export const upgradeDatabase = async (migrationsFolderPath: string, connection: mysql.Connection) => {
    try {
        const createdTable = await createMigrationsTable(connection);
        if (createdTable === CreatedStatus.Exists) console.log(successText("migrations table not created (exists)"));

        const failedMigrations: Array<{ id: number; }> = await getFailedMigrations(connection);
        const files: string[] = await readdir(migrationsFolderPath);

        // find migrations to run
        const migrationsToRun: string[] = files.filter((f) => {
            return failedMigrations.find(m => m.id === convertFilename(f).timestamp); // search on timestamp
        });

        // sort based on timestamp (chronological order)
        const sortedMigrationsToRun: string[] = migrationsToRun.sort((a, b) => {
            return convertFilename(a).timestamp - convertFilename(b).timestamp;
        });
        console.log(successText("migrations to run:"));
        for (const migration of migrationsToRun) console.log(convertFilename(migration).timestamp);

        // upgrade all migrations to run
        for (const file of sortedMigrationsToRun) {
            const migration: IMigrationFile = await import(path.resolve(path.join(migrationsFolderPath, file)));
            if (!migration.upgrade) throw new Error(`migration ${file} doesn't have an upgrade function`);

            const migrationInfo: IMigrationFileInfo = convertFilename(file);
            console.log(successText(`upgrading: migration ${migrationInfo.timestamp} (${migrationInfo.name})`));

            try {
                await migration.upgrade(connection);
                console.log(successText(`migration ${migrationInfo.timestamp} successfully upgraded`));
                await insertMigration(connection, migrationInfo, true);
            } catch (e) {
                await insertMigration(connection, migrationInfo, false);
                console.log(warningText(`migration ${migrationInfo.timestamp} failed upgrading`));
            }
        }
    } catch (e) {
        handleExceptionLazy(e, "upgrading database failed");
    }
};

const createMigrationsTable = async (connection: mysql.Connection): Promise<CreatedStatus> => {
    const existingTable = await connection.query("SHOW TABLES LIKE 'migrations'");
    if (existingTable && existingTable.length) return CreatedStatus.Exists;

    const createMigrationsTableQuery: string = `
        CREATE TABLE \`migrations\` (
            \`id\` int NOT NULL,
            \`name\` varchar(100) NOT NULL,
            \`succeeded\` tinyint(1) NOT NULL,
            \`created\` datetime NOT NULL,
            \`executed\` datetime NOT NULL,
            PRIMARY KEY (\`id\`)
        )
    `;

    await connection.query(createMigrationsTableQuery);
    return CreatedStatus.Created;
};

const insertMigration = async (connection: mysql.Connection, migrationFileInfo: IMigrationFileInfo, succeeded: boolean): Promise<void> => {
    const insertMigrationQuery: string = `
        INSERT IGNORE INTO migrations 
        (id, name, succeeded, created, executed)
        VALUES(?, ?, ?, ?, ?);
    `;

    const parameters: Array<number | string | Date | boolean> = [
        migrationFileInfo.timestamp, // id
        migrationFileInfo.name, // name
        succeeded, // succeeded
        new Date(migrationFileInfo.timestamp), // created
        new Date() // executed
    ];

    await connection.query(insertMigrationQuery, parameters);
};

const getFailedMigrations = async (connection: mysql.Connection): Promise<Array<{ id: number; }>> => {
    const getMigrationsQuery: string = "SELECT id FROM migrations WHERE succeeded = FALSE";
    const [failedMigrations] = await connection.query<DbQueryResult<Array<{ id: number; }>>>(getMigrationsQuery);
    return failedMigrations;
};