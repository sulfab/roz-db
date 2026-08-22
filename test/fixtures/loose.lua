-- navi_mob_data.lub ecrit dans une table posee par un autre fichier :
-- ici Absente n'existe pas au moment de l'affectation.
Absente = nil
Absente.champ = 42
lu = Absente.champ
Presente = { ok = true }
