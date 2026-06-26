-- CreateTable
CREATE TABLE "ParentEleveLink" (
    "id" SERIAL NOT NULL,
    "utilisateurId" INTEGER NOT NULL,
    "eleveId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParentEleveLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ParentEleveLink_eleveId_idx" ON "ParentEleveLink"("eleveId");

-- CreateIndex
CREATE UNIQUE INDEX "ParentEleveLink_utilisateurId_eleveId_key" ON "ParentEleveLink"("utilisateurId", "eleveId");

-- AddForeignKey
ALTER TABLE "ParentEleveLink" ADD CONSTRAINT "ParentEleveLink_utilisateurId_fkey" FOREIGN KEY ("utilisateurId") REFERENCES "Utilisateur"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParentEleveLink" ADD CONSTRAINT "ParentEleveLink_eleveId_fkey" FOREIGN KEY ("eleveId") REFERENCES "Eleve"("id") ON DELETE CASCADE ON UPDATE CASCADE;
