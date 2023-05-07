import http from "../http-common";

class AgendaDataService {
    get(id) {
        return http.get(`/agenda/${id}`);
    }

    update(id, data) {
        return http.put(`/agenda/${id}`, data);
    }

    delete(id) {
        return http.delete(`/agenda/${id}`);
    }

    deleteAll() {
        return http.delete(`/agenda`);
    }

    findByGreenhouse(greenhouse) {
        return http.get(`/agenda?greenhouse=${greenhouse}`);
    }
}

export default new AgendaDataService();