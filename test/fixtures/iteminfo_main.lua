-- Forme observee sur Ragnarok Zero : le fichier ne fait que definir main(),
-- c'est le client de jeu qui l'appelle. Sans cet appel, rien n'est construit.
function main()
	local tbl = {
		[501] = {
			unidentifiedDisplayName = "Red Potion",
			identifiedDisplayName = "Red Potion",
			identifiedResourceName = "red_potion",
			identifiedDescriptionName = { "Une potion rouge." },
			slotCount = 0,
		},
		[909] = {
			identifiedDisplayName = "Jellopy",
			identifiedResourceName = "jellopy",
			identifiedDescriptionName = { "Un morceau de gelee." },
			slotCount = 0,
		},
		[1202] = {
			identifiedDisplayName = "Knife",
			identifiedResourceName = "knife",
			identifiedDescriptionName = { "Un couteau." },
			slotCount = 3,
		},
		[2104] = {
			identifiedDisplayName = "Guard",
			identifiedResourceName = "guard",
			identifiedDescriptionName = { "Un bouclier." },
			slotCount = 1,
		},
	}
	for id, item in pairs(tbl) do
		local ok, msg = AddItem(id, item.unidentifiedDisplayName, item.identifiedDisplayName)
		if not ok then return false, msg end
	end
	return true
end
