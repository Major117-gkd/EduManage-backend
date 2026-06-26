-- Périmètre directeur (Primaire, Collège, Lycée)
ALTER TABLE "Utilisateur" ADD COLUMN IF NOT EXISTS "perimetre" TEXT;
