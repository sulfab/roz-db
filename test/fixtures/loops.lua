-- Les fichiers de navigation construisent parfois leurs tables par programme.
rows = {}
local maps = { "prt_fild08", "pay_fild04", "gef_fild00" }
for i = 1, 3 do
	for j = 1, 2 do
		table.insert(rows, { maps[i], 1000 + j, "Mob " .. j, j * 3, i * 10 + j })
	end
end

function helper(a, b)
	if a > b then return a else return b end
end
biggest = helper(41, 42)

counts = {}
for _, row in ipairs(rows) do
	local map = row[1]
	counts[map] = (counts[map] or 0) + 1
end
