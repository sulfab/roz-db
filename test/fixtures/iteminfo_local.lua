-- Variante des clients officiels : la table est locale, donc invisible
-- depuis les globales une fois le fichier execute.
local tbl = {
	[501] = {
		unidentifiedDisplayName = "Red Potion",
		identifiedDisplayName = "Red Potion",
		identifiedResourceName = "red_potion",
		identifiedDescriptionName = { "Une potion rouge." },
		slotCount = 0,
		ClassNum = 0,
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

local function main()
	for id, item in pairs(tbl) do
		result, msg = AddItem(id, item.unidentifiedDisplayName, item.identifiedDisplayName)
		if not result then return false, msg end
	end
	return true
end

main()
