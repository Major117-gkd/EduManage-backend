-- CreateTable
CREATE TABLE "Annonce" (
    "id" SERIAL NOT NULL,
    "titre" TEXT NOT NULL,
    "contenu" TEXT NOT NULL,
    "categorie" TEXT NOT NULL DEFAULT 'Info',
    "publiee" BOOLEAN NOT NULL DEFAULT false,
    "epinglee" BOOLEAN NOT NULL DEFAULT false,
    "auteurNom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Annonce_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Annonce_publiee_epinglee_createdAt_idx" ON "Annonce"("publiee", "epinglee", "createdAt");
