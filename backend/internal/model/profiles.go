package model

func ch(key, typ, label string, def int) Channel {
	return Channel{Key: key, Type: typ, Label: label, Default: def}
}

func dim() Channel    { return ch("dimmer", ChDimmer, "Intensité", 0) }
func red() Channel    { return ch("red", ChRed, "Rouge", 0) }
func green() Channel  { return ch("green", ChGreen, "Vert", 0) }
func blue() Channel   { return ch("blue", ChBlue, "Bleu", 0) }
func white() Channel  { return ch("white", ChWhite, "Blanc", 0) }
func amber() Channel  { return ch("amber", ChAmber, "Ambre", 0) }
func uv() Channel     { return ch("uv", ChUV, "UV", 0) }
func strobe() Channel { return ch("strobe", ChStrobe, "Strobe", 0) }
func mode() Channel   { return ch("mode", ChMode, "Mode", 0) }

// BuiltinProfiles returns the fixture templates shipped with the app. Real fixtures
// vary, so channel order can be edited per fixture to match its manual.
func BuiltinProfiles() []Profile {
	return []Profile{
		{ID: "par-rgb-3", Name: "PAR LED RVB (3 canaux)", Category: CatPar, BeamAngle: 25,
			Channels: []Channel{red(), green(), blue()}},
		{ID: "par-rgbw-4", Name: "PAR LED RVBW (4 canaux)", Category: CatPar, BeamAngle: 25,
			Channels: []Channel{red(), green(), blue(), white()}},
		{ID: "par-drgbs-6", Name: "PAR LED Dim + RVB + Strobe + Mode (6 canaux)", Category: CatPar, BeamAngle: 25,
			Channels: []Channel{dim(), red(), green(), blue(), strobe(), mode()}},
		{ID: "par-drgbw-7", Name: "PAR LED Dim + RVBW + Strobe + Mode (7 canaux)", Category: CatPar, BeamAngle: 25,
			Channels: []Channel{dim(), red(), green(), blue(), white(), strobe(), mode()}},
		{ID: "par-rgbwau-8", Name: "PAR LED Dim + RVBWA + UV + Strobe (8 canaux)", Category: CatPar, BeamAngle: 25,
			Channels: []Channel{dim(), red(), green(), blue(), white(), amber(), uv(), strobe()}},
		{ID: "bar-drgbs-5", Name: "Barre LED Dim + RVB + Strobe (5 canaux)", Category: CatBar, BeamAngle: 60,
			Channels: []Channel{dim(), red(), green(), blue(), strobe()}},
		{ID: "wash-drgbw-6", Name: "Wash Dim + RVBW + Strobe (6 canaux)", Category: CatWash, BeamAngle: 50,
			Channels: []Channel{dim(), red(), green(), blue(), white(), strobe()}},
		{ID: "moving-9", Name: "Lyre Pan/Tilt + Dim + RVBW + Strobe + Vitesse (9 canaux)", Category: CatMoving, BeamAngle: 14,
			Channels: []Channel{
				ch("pan", ChPan, "Pan", 128), ch("tilt", ChTilt, "Tilt", 128),
				ch("speed", ChSpeed, "Vitesse", 0), dim(), red(), green(), blue(), white(), strobe(),
			}},
		{ID: "strobe-2", Name: "Strobe Intensité + Vitesse (2 canaux)", Category: CatStrobe, BeamAngle: 110,
			Channels: []Channel{dim(), strobe()}},
		{ID: "fog-1", Name: "Machine à fumée (1 canal)", Category: CatFog, BeamAngle: 20,
			Channels: []Channel{ch("fog", ChFog, "Fumée", 0)}},
		{ID: "fog-2", Name: "Machine à fumée + Ventilateur (2 canaux)", Category: CatFog, BeamAngle: 20,
			Channels: []Channel{ch("fog", ChFog, "Fumée", 0), ch("fan", ChFan, "Ventilateur", 0)}},
		{ID: "laser-7", Name: "Laser DMX générique (7 canaux)", Category: CatLaser, BeamAngle: 40,
			Channels: []Channel{
				ch("mode", ChMode, "Mode (0 = éteint)", 0), ch("pattern", ChPattern, "Motif", 0),
				ch("color", ChColor, "Couleur", 0), ch("pan", ChPan, "Position X", 128),
				ch("tilt", ChTilt, "Position Y", 128), ch("speed", ChSpeed, "Vitesse", 128), strobe(),
			}},
		{ID: "dimmer-1", Name: "Projecteur traditionnel / gradateur (1 canal)", Category: CatOther, BeamAngle: 30,
			Channels: []Channel{dim()}},
	}
}
