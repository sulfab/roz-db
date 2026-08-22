-- Structure d'un vrai System/itemInfo.lub, en plus petit.
tbl = {
	[501] = {
		unidentifiedDisplayName = "Red Potion",
		unidentifiedResourceName = "red_potion",
		unidentifiedDescriptionName = { "Une potion." },
		identifiedDisplayName = "Red Potion",
		identifiedResourceName = "red_potion",
		identifiedDescriptionName = {
			"Une potion rouge qui rend",
			"^0000FF45^000000 points de vie.",
		},
		slotCount = 0,
		ClassNum = 0,
	},
	[909] = {
		unidentifiedDisplayName = "Jellopy",
		identifiedDisplayName = "Jellopy",
		identifiedResourceName = "jellopy",
		identifiedDescriptionName = { "Un morceau de gelee." },
		slotCount = 0,
		ClassNum = 0,
	},
	[1202] = {
		identifiedDisplayName = "Knife",
		identifiedResourceName = "knife",
		identifiedDescriptionName = { "Un couteau de base." },
		slotCount = 3,
		ClassNum = 1,
	},
}

function main()
	for id, item in pairs(tbl) do
		result, msg = AddItem(id, item.unidentifiedDisplayName, item.identifiedDisplayName)
	end
	return true
end

main()
