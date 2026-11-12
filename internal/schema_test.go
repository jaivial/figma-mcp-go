package internal

import "testing"

func TestValidNodeID(t *testing.T) {
	cases := []struct {
		id   string
		want bool
	}{
		{"4029:12345", true},
		{"I80:165050;80:162650", true}, // instance node: I prefix + chained parent IDs
		{"I1:2", true},
		{"80:165050", true},
		{"80-165050", false},
		{"", false},
		{"abc", false},
		{"1:2;bad", false},
	}
	for _, tc := range cases {
		if got := ValidNodeID(tc.id); got != tc.want {
			t.Errorf("ValidNodeID(%q) = %v, want %v", tc.id, got, tc.want)
		}
	}
}

func TestValidateRPCGetNodeInstanceIDs(t *testing.T) {
	if err := ValidateRPC("get_node", []string{"I80:165050;80:162650"}, nil); err != "" {
		t.Errorf("valid instance id rejected: %s", err)
	}
	if err := ValidateRPC("get_node", []string{"80-165050"}, nil); err == "" {
		t.Error("hyphen id accepted, want rejection")
	}
}
